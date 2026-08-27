# NexusQL 异步管道编排：实现、演示与面试讲解

## 1. 这次优化解决什么问题

同步接口要求 HTTP 请求一直等到数据管道结束。数据量变大、质量检查变慢或网络中断时，会出现三个问题：

1. 客户端不知道任务究竟没创建、仍在运行，还是已经成功；
2. 请求超时后缺少稳定的 Run ID，难以恢复查询；
3. 失败、重试和取消没有独立证据，面试中只能讲概念。

当前实现把“提交任务”和“执行管道”分离。API 先持久化任务并返回 `202 + run_id`，后台 Worker 再执行 `PipelineRuntime`。浏览器只按 Run ID 查询状态，不需要维持长连接。

## 2. 当前架构

```text
Studio
  │ POST /engineering/pipeline/runs
  ▼
FastAPI
  │ 先写入 queued
  ▼
orchestration.sqlite
  │
  ├── GET list/detail ──────► Studio 轮询与运行历史
  │
  ▼
ThreadPoolExecutor（单进程、单 Worker）
  │ running
  ▼
PipelineRuntime
  │
  ▼
DataAssetBuilder
  ├── Extract
  ├── Normalize + Stage
  ├── Quality Gate + Quarantine
  ├── Atomic Publish + Watermark
  └── Semantic Catalog + Contract Validation
```

核心代码：

- `queryforge/application/pipeline_orchestrator.py`：任务状态、持久化、后台执行、重试和取消；
- `queryforge/application/pipeline_runtime.py`：受控样例场景和运行证据聚合；
- `queryforge/data_assets/pipeline.py`：数据资产执行与阶段耗时；
- `queryforge/interfaces/api/app.py`：202、查询、重试和取消 API；
- `web/app/page.tsx`：任务提交、轮询和可观测详情。

## 3. 状态机

```text
queued ──worker 获取任务──► running ──成功──► succeeded
  │                           │
  │ cancel                    ├──质量/合同失败──► failed
  ▼                           └──执行异常──────► failed
cancelled

failed/cancelled ──人工 retry──► 新的 queued 任务
```

重要约束：

- 终态不会被原地改成 queued；重试永远创建新的 Run ID；
- 新任务使用 `retry_of` 指向原任务，`attempt` 加一；
- 数据质量错误默认 `retryable=false`，表示不应该自动盲目重试；
- 人工修复数据或合同后仍可创建新 attempt；
- 只取消尚未执行的 queued 任务；running 任务不会被强制杀死。

## 4. 为什么运行中不能直接强制取消

数据管道需要维护发布库、元数据库、语义模型和 Watermark 的一致性。若在 SQLite 提交、文件替换或回滚中间强制终止线程，可能留下半成功状态。

因此当前取消语义是：

- queued：从执行器队列移除，写入 `cancelled`；
- running：返回 `409`，不做不安全的线程终止；
- 生产化：在 Extract、Validate、Publish 前后的安全边界检查 `cancel_requested`，数据库操作使用事务和可取消查询。

这不是“取消功能不完整”，而是明确选择一致性优先。面试时要主动说明这一点。

## 5. 持久化表保存什么

`orchestration.sqlite` 中的 `pipeline_operations` 保存：

| 字段 | 作用 |
|---|---|
| `run_id` | 客户端稳定查询标识 |
| `scenario` | standard 或 quality_failure |
| `status` | queued/running/succeeded/failed/cancelled |
| `attempt` | 当前尝试次数 |
| `retry_of` | 指向上一失败或取消任务 |
| `retryable` | 是否适合自动重试 |
| `error_type` | data_quality_error、contract_error、execution_error 等 |
| `error_message` | 可读失败摘要 |
| `result_json` | 完整管道结果快照 |
| `created_at` | 提交时间 |
| `started_at` | Worker 开始时间 |
| `finished_at` | 进入终态时间 |
| `queue_delay_ms` | 排队耗时 |
| `execution_duration_ms` | Worker 执行耗时 |

索引 `idx_pipeline_operations_status_created` 服务于“按状态读取最近任务”的真实查询模式，而不是为了显得复杂随意增加索引。

## 6. 进程重启如何恢复

本地线程无法跨进程继续执行。服务启动时如果发现数据库中仍有 queued 或 running，系统不会假装它们还在运行，而是统一转成：

```text
status = failed
error_type = worker_interrupted
retryable = true
```

这样客户端能得到确定终态，并可创建新 attempt。生产队列可以进一步实现 visibility timeout、heartbeat 和租约续期。

## 7. 阶段级耗时

`DataAssetBuilder` 在每个资产结果的 `details` 中记录：

- `extract`：读取 CSV、Parquet 或 API；
- `normalize_and_stage`：字段标准化、Watermark 过滤和 Staging；
- `quality`：必填、唯一键、历史键与阈值检查；
- `publish`：目标表写入和 Watermark 更新；
- `semantic_catalog`：语义目录更新；
- `semantic_publication_ms`：模型写出和物理合同校验；
- `batch_duration_ms`：包含语义门禁与必要回滚的原子批次耗时。

失败时还会记录 `failed_stage`。这让“质量失败发生在哪里”成为结构化证据，而不是只看一段异常字符串。

## 8. API 操作示例

创建正常任务：

```bash
curl -X POST http://127.0.0.1:8000/engineering/pipeline/runs \
  -H "content-type: application/json" \
  -d '{"scenario":"standard"}'
```

创建质量失败任务：

```bash
curl -X POST http://127.0.0.1:8000/engineering/pipeline/runs \
  -H "content-type: application/json" \
  -d '{"scenario":"quality_failure"}'
```

查询任务：

```bash
curl http://127.0.0.1:8000/engineering/pipeline/runs/<run_id>
```

查询最近任务：

```bash
curl "http://127.0.0.1:8000/engineering/pipeline/runs?limit=20"
```

创建重试任务：

```bash
curl -X POST http://127.0.0.1:8000/engineering/pipeline/runs/<run_id>/retry
```

取消排队任务：

```bash
curl -X POST http://127.0.0.1:8000/engineering/pipeline/runs/<run_id>/cancel
```

## 9. 前端演示顺序

1. 进入 Anime Streaming 数据域的 Data Pipelines；
2. 点击“运行管道检查”；
3. 指出接口先返回 queued/running，而不是阻塞页面；
4. 展示 Run ID、attempt、排队耗时和执行耗时；
5. 展示 Extract、Validate、Transform、Publish 各阶段耗时与行数；
6. 再次运行，说明 Watermark 导致 `published_rows=0` 的幂等空运行；
7. 点击“模拟质量失败”；
8. 展示 `data_quality_error`、failed_stage、Quarantine 与 Watermark 不推进；
9. 点击创建重试任务，说明原失败证据不修改，新任务通过 `retry_of` 关联。

## 10. 面试回答模板

### 为什么不用一个同步 POST

> 同步 POST 适合极小 Demo，但超时后客户端无法区分任务是否仍在执行。我把控制面状态先写入 SQLite，返回 202 和 Run ID，再由单 Worker 执行，前端按 ID 轮询。这样任务状态、失败和重试都有持久化证据。

### 这算分布式调度吗

> 不算。当前是 SQLite 加单进程 ThreadPoolExecutor，目的是把状态机、恢复语义和 API 合同做实。多实例部署时要把状态放到 PostgreSQL，把执行器换成外部队列，并增加租约、心跳和幂等创建键。

### 为什么质量失败标记不可重试却还有 retry API

> `retryable=false` 表示系统不应自动无脑重试，因为同一份坏数据不会自己变好；人工修复源数据或合同后可以显式创建新的 attempt。自动重试策略和人工重试能力是两个概念。

### 如何防止重试覆盖历史

> 重试不更新原任务，而是生成新的 Run ID，attempt 加一，并用 retry_of 指向原任务。这样审计链不会丢失，也能计算每条任务链的最终结果和重试成本。

### 进程中途退出怎么办

> 本地线程无法恢复指令位置，所以启动时把遗留 queued/running 标记为 worker_interrupted 和 retryable，给客户端确定终态。生产队列则使用租约超时和重新投递，但底层发布仍必须幂等。

## 11. 当前边界与下一步

当前真实边界：

- 状态持久化，但 Worker 仍在 API 进程内；
- 样例管道已异步，自定义文件发布仍同步；
- queued 可取消，running 不强杀；
- 支持人工重试，没有指数退避自动重试；
- 单 Worker 串行，没有跨实例租约；
- 指标是单次耗时，没有 P50/P95 趋势和告警。

下一步优先级：

1. PostgreSQL 控制面和 Source/Publisher Adapter；
2. 外部 Worker、租约、heartbeat 和幂等创建键；
3. 将异步编排推广到自定义资产发布；
4. 迟到数据 Lookback、Upsert 和复合 Watermark；
5. 阶段耗时趋势、P95、SLA 和失败告警。

## 12. 测试证据

相关测试覆盖：

- 正常任务 queued/running/succeeded 生命周期；
- 任务状态和结果跨查询持久化；
- 阶段耗时、排队耗时和执行耗时存在；
- 质量失败分类为 `data_quality_error`；
- retry 生成 attempt=2 且保留 retry_of；
- 排队任务可以取消而不影响正在执行的任务；
- FastAPI create/detail/list/retry 合同。

当前仓库全量回归共 260 项，259 项通过，1 项可选依赖跳过。
