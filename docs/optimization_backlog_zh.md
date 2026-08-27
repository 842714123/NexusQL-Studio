# QueryForge 优化评估与实施优先级

## 1. 总体判断

当前项目已经完成首个非样例数据闭环：Web 对 CSV/Parquet 做真实剖析，审核合同后调用 Python `DataAssetBuilder`，发布域级 SQLite、语义模型和 SQL 策略，自定义数据域查询只使用自己的产物。最需要避免的是继续横向添加很多“看起来丰富但没有真实后端”的页面。

后续优化应优先加强三件事：

1. 数据开发真实性：真实数据库、增量策略、调度和失败恢复。
2. 可证明性：运行详情、耗时、质量趋势、血缘和可重复演示。
3. 工程边界：adapter、异步任务、认证、部署和可观测性。

## 2. 推荐优先级总表

| 优先级 | 优化项 | 求职价值 | 开发成本 | 建议 |
|---|---|---:|---:|---|
| P0 | PostgreSQL 数据源与发布 adapter | 很高 | 中 | 下一项实施 |
| 已完成 | 本地持久化异步状态机与失败重试 | 很高 | 中 | 已实现并有 API/测试证据 |
| 已完成 | 运行详情与阶段耗时 | 高 | 低至中 | 已接入 Data Pipelines 页面 |
| 已完成 | SQLite 迟到数据 lookback + upsert | 很高 | 中 | 已实现；下一步迁移 PostgreSQL/湖仓 |
| P1 | Docker Compose 一键启动 | 高 | 低 | 面试前完成 |
| P1 | 重复主键、类型错误失败场景 | 中高 | 低 | 补齐演示矩阵 |
| P1 | 字段级血缘 | 高 | 中高 | 完成 SQL 转换抽象后 |
| P1 | 数据质量趋势和 SLA 告警 | 高 | 中 | 有运行历史后实施 |
| P1 | DuckDB + Parquet | 高 | 中 | 偏离线分析岗位时优先 |
| P2 | dbt 集成 | 中高 | 中 | 投递数仓岗位时有价值 |
| P2 | OpenTelemetry + Prometheus | 中 | 中 | 强调平台工程时实施 |
| P2 | 登录、RBAC、多租户 | 中 | 高 | 不宜早于数据能力 |
| P3 | 更多视觉动画和图表 | 低 | 中 | 暂缓 |

### 已完成的 P0 基础闭环

- CSV/Parquet 上传内容真实剖析，而非前端固定字段。
- 候选主键、Watermark、类型、空值数和基数可审核。
- 审核后的语义/质量合同会实际驱动 `DataAssetBuilder`。
- 发布生成 SQLite、语义模型、SQL 策略、运行 ID 和 Watermark 证据。
- 自定义域查询读取自己的发布路径，失败时不回退到样例答案。
- 管道任务持久化 queued、running、succeeded、failed、cancelled 状态。
- 进程重启可识别未完成任务，失败记录包含 error_type 与 retryable。
- retry 创建新 attempt 并保存 retry_of；排队任务支持安全取消。
- Extract、Normalize/Stage、Quality、Publish、语义发布与批次总耗时可查看。
- ISO 时间 Watermark 支持有界 Lookback，唯一键 Upsert 可修正迟到记录并输出 insert/update/late 证据。

## 3. 最值得立刻优化的五项

### 3.1 PostgreSQL adapter

为什么值得：

- 数据开发岗位很少只使用 SQLite。
- 能展示连接池、事务、schema introspection、分页读取和 upsert。
- 面试官可以继续追问索引、隔离级别和执行计划。

建议设计：

- 定义 SourceReader、MetadataStore、Publisher 接口。
- 保留 SQLite adapter 作为本地 demo。
- PostgreSQL 使用 psycopg 或 SQLAlchemy。
- 用 INSERT ON CONFLICT 完成幂等 upsert。
- 用 advisory lock 避免同一资产被多个 worker 同时执行。
- 使用 Testcontainers 做集成测试。

验收标准：

- 可配置 PostgreSQL 连接但不在仓库保存密码。
- 能发现 schema 与主键。
- 能从 PostgreSQL 抽取并发布一张示例表。
- 重复运行不增加重复记录。
- 事务失败时 watermark 不推进。

### 3.2 异步任务状态机（本地版本已实现）

当前已实现以下状态：

    queued -> running -> succeeded
                      -> failed
                      -> cancelled

当前真实记录：

- run id、scenario、状态、attempt、retry_of。
- created/start/end 时间。
- 每阶段输入输出行数与耗时。
- 错误分类：临时错误、数据质量错误、配置错误。
- queue_delay_ms、execution_duration_ms、error_type、retryable。

当前 API：

- POST 创建任务并返回 202 + run id。
- GET 查询单次运行。
- GET 查询运行列表。
- POST retry / cancel。
- 前端通过轮询更新，并显示任务与阶段证据。

当前边界：执行器仍是单进程 `ThreadPoolExecutor`，状态存放在本地
SQLite。下一步不是再造一套页面，而是把执行器替换为 Celery/Dramatiq、
云队列或调度平台 Worker，把租约和状态迁移到 PostgreSQL，并在安全阶段
边界检查取消标记。

### 3.3 迟到数据与 upsert（SQLite 版已实现）

当前严格 watermark 适合解释基础增量，但生产数据经常迟到。

当前实现：

- `watermark_lookback_seconds` 从 Watermark 向前回看有界窗口。
- 使用审核后的业务唯一键进行批内检查和数据库唯一索引兜底。
- `publish_mode: upsert` 对新键 INSERT、已有键 UPDATE。
- 记录有效下界、late_rows、inserted_rows 和 updated_rows。
- 质量或语义失败时回滚目标表与 Watermark。

下一步增加 event_time/ingestion_time 双时间、复合游标、Source 谓词下推和
迟到分钟数分布，再迁移到 PostgreSQL `ON CONFLICT` 或湖仓 MERGE。

面试价值：可以自然引出流处理 watermark、乱序、exactly-once 与业务幂等的区别。

### 3.4 运行详情和阶段耗时（基础版已实现）

当前页面已经展示：

- Extract、Validate、Transform、Publish 时间线。
- 每阶段耗时和行数。
- watermark 前后值。
- 失败类型、失败阶段和可重试判断。
- quarantine 样本与导出。
- attempt、retry_of、排队耗时和原子批次总耗时。

后续可增加 Quarantine 导出、发布版本、语义模型版本和耗时趋势/P95。

### 3.5 Docker Compose

建议包含：

- queryforge-api
- queryforge-web
- postgres
- 可选的 worker

配套：

- healthcheck。
- .env.example。
- 初始化样例数据。
- 一条命令启动和停止。
- README 中保留本地 Python 启动方式。

## 4. 当前代码层面值得优化的点

### PipelineRuntime 职责

当前 runtime 同时处理场景数据构造、执行和状态聚合，随着功能增加会变重。

建议拆分：

- PipelineExecutor：执行资产构建。
- PipelineRunRepository：读写运行证据。
- PipelineScenarioFactory：只服务 demo 场景。
- PipelineStatusService：组装 API read model。

### 运行证据 schema

当前 JSON 适合快速保存完整结果，但常用字段应结构化：

- status、scenario、started_at、finished_at。
- input/staged/published/quarantined rows。
- watermark before/after。
- error_type、retryable。

完整 payload 可继续作为 JSON 快照。对 status、created_at、asset_name 等真实查询条件建立索引，并用 EXPLAIN QUERY PLAN 验证。

### 质量规则表达

目前规则适合基础门禁，可扩展为：

- severity：warning / error。
- action：quarantine / block / observe。
- threshold 和 sampling。
- rule version 与 owner。
- 按运行保存实际值和期望值。

### API 合同

- 为 scenario 使用枚举请求模型，而不是长期依赖自由字符串。
- 为 PipelineStatus 建立显式响应 schema。
- 增加分页、limit 上限和稳定错误码。
- 使用 409 表达已有管道运行中。
- 使用 422 表达质量或契约阻断，并保留 run id。

### 前端状态

- 将超大的 page.tsx 拆为 Domains、Pipelines、Semantic、Ask、Runs 组件。
- 将中英文文案移到独立字典，避免组件中大量 text 调用。
- 使用统一 API client 和错误类型。
- 给运行详情、失败记录增加键盘操作与可访问性测试。
- 对时间、状态、数字格式做统一 formatter。

### 测试

值得增加：

- 并发启动两个运行，验证一个返回冲突。
- 发布失败后证据存在而目标表、水位线不变。
- 重复主键和类型错误场景。
- API 非法 scenario。
- 运行历史分页与排序。
- PostgreSQL Testcontainers 集成测试。
- 前端失败按钮与历史列表的组件测试。

## 5. 暂时不建议优先做的内容

- 为了“像大数据”而直接加入 Kafka、Flink、Spark 全家桶。
- 在没有身份模型前先做复杂多租户 UI。
- 继续添加大量静态 dashboard。
- 训练自有大模型。
- 过早微服务化。
- 为小数据集做没有证据支持的缓存和索引。

这些功能并非无价值，但会扩大项目范围，降低你对核心代码的掌握程度。

## 6. 推荐实施顺序

### 第一阶段：已完成与近期

1. 已完成运行状态、阶段耗时与重试详情。
2. 重复主键和类型错误失败场景。
3. Docker Compose。
4. 拆分前端 Pipeline 组件。

### 第二阶段：两周内

1. 数据访问 adapter。
2. PostgreSQL source/publisher。
3. upsert 和迟到数据回看。
4. Testcontainers 集成测试。

### 第三阶段：后续

1. 将本地 Worker 替换为外部队列和跨进程租约。
2. 增加安全阶段取消标记和 SSE 推送。
3. 字段级血缘。
4. 质量趋势、SLA 和告警。

## 7. 做到什么程度就适合投递

现在已经可以用于投递实习，但如果完成以下四项，竞争力会明显提高：

- PostgreSQL adapter。
- Docker Compose 一键启动。
- 单次运行详情与失败重试。
- 迟到数据 + upsert 演示。

面试时能够亲手画出架构、运行正常与失败路径、说明当前边界，并现场修改一个质量规则，比继续堆叠技术名词更重要。
