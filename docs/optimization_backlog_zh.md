# QueryForge 优化评估与实施优先级

## 1. 总体判断

当前项目的优点是链路完整：数据管道、语义层、安全 NL2SQL、API、双语界面和测试已经能形成闭环。最需要避免的是继续横向添加很多“看起来丰富但没有真实后端”的页面。

后续优化应优先加强三件事：

1. 数据开发真实性：真实数据库、增量策略、调度和失败恢复。
2. 可证明性：运行详情、耗时、质量趋势、血缘和可重复演示。
3. 工程边界：adapter、异步任务、认证、部署和可观测性。

## 2. 推荐优先级总表

| 优先级 | 优化项 | 求职价值 | 开发成本 | 建议 |
|---|---|---:|---:|---|
| P0 | PostgreSQL 数据源与发布 adapter | 很高 | 中 | 下一项实施 |
| P0 | 异步任务状态机与失败重试 | 很高 | 中 | PostgreSQL 后实施 |
| P0 | 运行详情页与阶段耗时 | 高 | 低至中 | 可并入状态机 |
| P0 | 迟到数据 lookback + upsert | 很高 | 中 | 与 PostgreSQL 一起做 |
| P1 | Docker Compose 一键启动 | 高 | 低 | 面试前完成 |
| P1 | 重复主键、类型错误失败场景 | 中高 | 低 | 补齐演示矩阵 |
| P1 | 字段级血缘 | 高 | 中高 | 完成 SQL 转换抽象后 |
| P1 | 数据质量趋势和 SLA 告警 | 高 | 中 | 有运行历史后实施 |
| P1 | DuckDB + Parquet | 高 | 中 | 偏离线分析岗位时优先 |
| P2 | dbt 集成 | 中高 | 中 | 投递数仓岗位时有价值 |
| P2 | OpenTelemetry + Prometheus | 中 | 中 | 强调平台工程时实施 |
| P2 | 登录、RBAC、多租户 | 中 | 高 | 不宜早于数据能力 |
| P3 | 更多视觉动画和图表 | 低 | 中 | 暂缓 |

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

### 3.2 异步任务状态机

当前同步 POST 适合小型 demo，但长任务会占用请求。

建议状态：

    queued -> running -> succeeded
                      -> failed
                      -> cancelled

需要记录：

- run id、asset id、状态、attempt。
- created/start/end 时间。
- 每阶段输入输出行数与耗时。
- 错误分类：临时错误、数据质量错误、配置错误。
- retry_at、最大重试次数和取消标记。

API 应改为：

- POST 创建任务并返回 202 + run id。
- GET 查询单次运行。
- GET 查询运行列表。
- POST retry / cancel。
- 前端通过轮询或 SSE 更新。

### 3.3 迟到数据与 upsert

当前严格 watermark 适合解释基础增量，但生产数据经常迟到。

优化方案：

- 每次从 watermark 向前回看一个窗口。
- 使用 event_id 等业务主键去重。
- 目标表采用 upsert。
- 区分 event_time 和 ingestion_time。
- 记录迟到分钟数及迟到行数指标。

面试价值：可以自然引出流处理 watermark、乱序、exactly-once 与业务幂等的区别。

### 3.4 运行详情和阶段耗时

当前已有运行列表，但还可以增加单次详情抽屉：

- Extract、Validate、Transform、Publish 时间线。
- 每阶段耗时和行数。
- watermark 前后值。
- 失败堆栈摘要和可重试判断。
- quarantine 样本与导出。
- 发布版本和语义模型版本。

这是低成本、高展示价值优化。

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

### 第一阶段：一周内

1. 运行详情页。
2. 重复主键和类型错误失败场景。
3. Docker Compose。
4. 拆分前端 Pipeline 组件。

### 第二阶段：两周内

1. 数据访问 adapter。
2. PostgreSQL source/publisher。
3. upsert 和迟到数据回看。
4. Testcontainers 集成测试。

### 第三阶段：后续

1. 异步 worker 和任务状态机。
2. retry/cancel/SSE。
3. 字段级血缘。
4. 质量趋势、SLA 和告警。

## 7. 做到什么程度就适合投递

现在已经可以用于投递实习，但如果完成以下四项，竞争力会明显提高：

- PostgreSQL adapter。
- Docker Compose 一键启动。
- 单次运行详情与失败重试。
- 迟到数据 + upsert 演示。

面试时能够亲手画出架构、运行正常与失败路径、说明当前边界，并现场修改一个质量规则，比继续堆叠技术名词更重要。
