# QueryForge 面试讲解与备战手册

## 1. 项目到底解决什么问题

QueryForge 不是单纯的“聊天生成 SQL”。它解决三个互相关联的问题：

1. 数据如何可信地进入分析库：规范化、staging、质量检查、quarantine 和原子发布。
2. AI 如何理解业务口径：用 YAML 语义层描述实体、维度、指标、关系、Join Path 和运营契约。
3. AI 生成的 SQL 如何安全执行：经过 AST 解析、策略检查、复杂度预算和 SQLite 只读执行。

个人二次开发重点是第一部分和产品化：将已有数据资产构建能力封装为可运行、可查询、可观测的后端 API，并把真实状态接入中英文 Studio。

## 2. 架构讲解

    CSV / Parquet / JSON API
              |
              v
    规范化 -> staging -> 质量门禁 -> quarantine
              |
              v
    发布 SQLite + 语义模型
              |
              +-> watermark / lineage / run metadata
              |
              +-> Governed NL2SQL
              |   schema linking -> 候选 SQL -> AST 策略
              |   -> 只读执行 -> 有限修复 -> 结果
              |
              +-> FastAPI -> React/TypeScript Studio

分层职责：

| 分层 | 职责 |
|---|---|
| domain | SQL 策略、语义契约、质量规则等业务不变量 |
| application | AgentService、PipelineRuntime 等用例编排 |
| infrastructure | SQLite、模型提供商、存储实现 |
| workflow | NL2SQL 节点、候选选择、修复和报告 |
| interfaces | CLI、REST/SSE、MCP、Gateway |
| web | 双语 Studio、前端状态与 API 代理 |

## 3. 数据管道详细流程

一次正常运行：

1. 读取受控资产配置，确定数据源、目标表、watermark 字段和质量规则。
2. 读取源数据，将字段标准化为 snake_case，清理空白并推断 SQLite 类型。
3. 根据上次成功 watermark 筛选增量数据，先写 staging。
4. 执行非空、唯一性、可接受值和自定义条件等检查。
5. 记录问题行到 quarantine；强制门禁失败则阻止发布。
6. 数据和已评审语义契约同时成功后，原子发布并更新 watermark。
7. 记录血缘、行数、质量结果和运行状态，供 API 与 Studio 查询。

为什么需要 staging：

- 将读取和校验与对外服务表隔离。
- 失败时不污染上一个可用版本。
- 能判断错误发生在源数据、转换、质量还是发布阶段。
- 为 merge、SCD 和分区替换预留边界。

## 4. watermark、幂等和一致性

watermark 表示已经成功发布的最大增量位置，可以是时间或单调 ID。新运行只处理比它更新的记录。没有新数据时，运行成功但发布 0 行，称为幂等空运行。

正确顺序：

    读取旧 watermark
    -> 处理增量
    -> 通过质量与语义门禁
    -> 完成数据和语义发布
    -> 最后推进 watermark

如果先推进 watermark 再发布，发布失败后就会永久跳过没有成功处理的数据。

当前 PipelineRuntime 使用非阻塞进程内锁，避免同一 API 进程重复执行样例管道。它不是分布式锁；多实例部署应使用 PostgreSQL advisory lock、Redis lease 或调度系统唯一任务约束。

## 5. 原子发布与回滚

目标是让查询方只看到“上一个完整版本”或“新的完整版本”，不能看到一半新、一半旧。数据或语义契约任一发布失败，都保留旧版本并恢复 watermark。质量门禁是发布条件，而不是发布完成后的报表。

## 6. 语义层与 NL2SQL

物理 schema 只说明有哪些表和字段，无法稳定表达“活跃用户如何定义”“收入是否含税”“应该通过哪条 Join Path”。语义层把业务口径变成可版本化、可评审、可验证的配置。

查询链路：

    用户问题
    -> 主题和时间解析
    -> schema linking 与语义检索
    -> 候选 SQL
    -> AST 安全策略
    -> SQLite 只读执行
    -> 结果反思与有限修复
    -> 结果、SQL、解释和运行记录

提示词中的“只生成 SELECT”不是安全保证。模型可能幻觉、被误导或遭受提示注入。QueryForge 在模型之后解析 SQL AST，拒绝写操作、未授权对象和过大的 join，再通过操作系统级只读数据库连接执行。

## 7. API 与前端设计

- FastAPI 路由只暴露用例，不重复实现管道核心逻辑。
- GET /engineering/pipeline/status 只读查询持久化状态。
- POST /engineering/pipeline/run 发起受控样例管道。
- 当前数据量小，所以同步返回；生产版应返回 202 和 run id，再轮询或通过 SSE 更新。
- 浏览器不能传任意本地配置路径，避免路径穿越和执行未审核资产配置。
- React 工作台展示 DAG、SLA、质量、血缘、watermark 和最近运行，并支持中英文偏好持久化。

## 8. 测试策略

新增管道测试重点不是只验证“能运行”，而是验证状态转换：

1. 首次运行发布行数大于 0。
2. 质量规则数量与通过数量正确。
3. 成功后 watermark 持久化。
4. 第二次运行返回 idempotent 且发布 0 行。
5. 第二次运行前后 watermark 不变。
6. API 状态与运行结果合同一致。

完整回归当前运行 252 项测试，251 项通过，1 项平台条件跳过；前端通过 ESLint、TypeScript 和生产构建。

## 9. 高频问题与回答

### Q1：和普通 NL2SQL 有什么区别？

普通方案往往把 schema 给模型后直接执行 SQL。QueryForge 在数据之前有质量与发布管道，在模型上下文中有可评审语义层，在执行之前有确定性安全策略，执行之后有可追溯记录。重点是可治理和可信，而不只是“生成 SQL”。

### Q2：如何处理迟到数据？

当前 demo 按严格大于 watermark 处理。生产方案会加入 lookback window，每次回看一定范围，再用业务主键和 upsert 去重。回答时要说明这是规划中的增强，不要说已经实现。

### Q3：如何保证幂等？

输入范围由已成功 watermark 决定，无新数据时不发布。目标侧还应使用稳定业务主键和 merge/upsert 作为第二道保障。当前自动化测试已经验证第二次执行发布 0 行且 watermark 不变。

### Q4：质量检查失败怎么办？

记录失败规则和问题行，写入 quarantine，阻止发布，不推进 watermark，保留上一个可用版本；修复源数据或规则后重跑同一批数据。

### Q5：为什么选 SQLite？

目标是本地优先、可复现的作品集项目。SQLite 无服务依赖，便于做只读连接、事务和测试。但它不是生产数仓；下一步应抽象 SourceReader 和 Publisher，增加 PostgreSQL 或 DuckDB adapter。

### Q6：亿级数据如何改造？

不再使用单机 SQLite 和同步 API。接入层可用 Kafka/CDC 或对象存储分区文件，计算层用 Spark/Flink/Trino 或云数仓，调度用 Airflow/Dagster，状态元数据放独立数据库；现有契约、门禁、watermark、幂等和血缘抽象仍然保留。

### Q7：为什么不允许前端传任意配置路径？

任意路径可能读取超出业务范围的本地文件，或执行未审核资产配置。当前只映射固定样例；生产版应使用服务端资产 ID、权限和配置记录映射。

### Q8：为什么语义契约必须人工评审？

自动推断可生成初稿，但指标口径、粒度、所有者和 Join Path 是业务决策，不应由模型自动发布。reviewed 门禁把人的责任放在发布之前。

### Q9：项目最难的问题是什么？

建议讲“在不重写原有 builder 的情况下增加稳定 API 状态”。先定义状态合同，再从 lineage、watermark、quality report 和发布库汇总，最后用独立 application runtime 隔离 Web 与核心 builder。这样复用成熟逻辑，同时避免路由直接操作文件和数据库。

### Q10：这是你从零写的吗？

不是。项目来自同事，我获得授权后进行二次开发。我先通过测试和文档理解原有 NL2SQL、语义层和资产构建边界，个人重点完成双语 Studio、PipelineRuntime、管道 REST API、真实状态接入和相应测试。我能清楚区分原有能力与个人改造，并解释自己写的边界。

## 10. 扩展设计题

### 增加 PostgreSQL

1. 定义 SourceReader 与 Publisher 接口，把 SQLite 变成 adapter。
2. 用 psycopg/SQLAlchemy 实现 schema 发现、分页抽取和事务发布。
3. watermark 表增加 asset id 和 partition 维度。
4. 使用 INSERT ON CONFLICT 实现幂等 upsert。
5. 用 Testcontainers 做真实 PostgreSQL 集成测试。

### 增加异步调度

- API 创建 run record、投递任务，返回 202 和 run id。
- Worker 获取资产级租约并执行 queued -> running -> succeeded/failed/cancelled。
- 记录每阶段 attempt、耗时、输入输出行数和错误类型。
- 暂时性错误指数退避；数据契约失败不应盲目自动重试。
- Studio 通过轮询或 SSE 展示进度。

### 增加字段级血缘

- 记录目标字段、源字段、转换表达式、发布版本和 run id。
- SQL 转换通过 AST 解析；声明式映射直接记录。
- 无法解析的 UDF 标记 unknown，不伪造血缘。
- 血缘与发布版本一致，支持影响分析和回滚。

## 11. 五分钟演示脚本

1. 30 秒：数据域页面，解释业务上下文隔离。
2. 60 秒：数据管道页面，介绍 Extract、Validate、Transform、Publish。
3. 45 秒：展示 4/4 质量门禁、watermark 和血缘。
4. 45 秒：再次运行，解释幂等空运行为什么发布 0 行。
5. 60 秒：语义工作台，介绍实体、指标、Join Path 和人工评审。
6. 60 秒：自然语言提问，展示 SQL、结果和运行记录。

最好再准备一个故意失败的数据文件，展示 quarantine、发布被阻止和 watermark 不推进，这会比一直展示绿色成功状态更有说服力。

## 12. STAR 项目故事

Situation：原项目有 NL2SQL、语义层和数据资产构建能力，但缺少可直观展示管道运行、质量、增量和血缘的产品界面。

Task：尽量不破坏原架构，将 builder 封装成稳定运行时和 API，并让前端反映真实持久化状态。

Action：阅读资产与语义边界；增加 PipelineRuntime 汇总 lineage、watermark、quality report 和发布库；限制 API 只运行固定受控资产；把前端 DAG 和观测卡片接入真实响应；补充首次运行、二次幂等和 API 测试。

Result：实测首次发布 5 行，4/4 质量门禁通过，watermark 为 2026-01-03；第二次发布 0 行且水位线不变；质量失败时隔离 1 行且不推进 watermark；完整回归覆盖 252 项测试。

## 13. 面试前必须亲手过一遍

- pipeline_runtime.py：状态汇总、进程锁和幂等结果。
- interfaces/api/app.py：API 为什么依赖 application service。
- queryforge/data_assets/pipeline.py：staging、质量、发布与回滚顺序。
- queryforge/domain/security/sql_policy.py：AST 校验与 SQL 策略边界。
- workflow/workflow_runner.py：NL2SQL 节点、修复预算和失败路径。
- web/app/page.tsx：双语上下文和真实 pipeline API。
- tests/test_pipeline_runtime.py：为什么二次运行测试比只测首次成功更重要。

面试前检查：

- 能不看稿讲完 30 秒和 3 分钟版本。
- 能画出数据管道和 NL2SQL 两条主链路。
- 能解释 staging、watermark、幂等、quarantine、原子发布和语义层。
- 能主动说出 SQLite、单进程锁、受控本地环境三个边界。
- 能清楚区分原项目能力和个人二次开发。

---

# 深度面试篇

## 14. 三种长度的项目介绍

### 14.1 15 秒版本

“QueryForge 是一个把数据资产管道、语义层和安全 NL2SQL 串起来的本地优先分析平台。我在原项目上完成了管道运行时、质量失败审计、真实 API 接入和中英文 Studio，让增量、幂等、隔离和回滚都能实际演示。”

适用：自我介绍中快速带过项目，等待面试官决定是否追问。

### 14.2 60 秒版本

“这个项目要解决的不是单纯生成 SQL，而是数据如何可信地进入分析系统，以及 AI 如何在受治理的语义和安全边界内查询。我在同事原项目的基础上做二次开发：第一，把 CSV 经过字段规范化、staging、质量门禁、quarantine 和原子发布构建成 SQLite 分析资产；第二，用 watermark 记录最后成功位置，实现增量与幂等；第三，增加 PipelineRuntime 和 FastAPI 接口，把行数、质量、血缘、水位线和运行历史接到 React/TypeScript 双语工作台；第四，增加受控质量失败场景，证明失败时发布 0 行、水位线不推进，而且审计证据不会随发布回滚消失。当前完整回归是 252 项测试。”

适用：面试官问“介绍一个你最熟悉的项目”。

### 14.3 三分钟版本

第一段——问题：

“很多 NL2SQL demo 只做 schema 加 prompt 再执行 SQL，但真实数据分析至少有三个风险：源数据质量不可靠、业务指标口径不明确、模型输出不能直接信任。”

第二段——架构：

“QueryForge 在上游用数据资产管道完成规范化、暂存、质量校验、隔离和发布；中间用 YAML 语义层定义实体、粒度、指标、关系和 Join Path；下游用工作流生成候选 SQL，再经过 AST 安全策略和 SQLite 只读连接执行。CLI、REST/SSE、MCP 和 Web 都复用同一 application service。”

第三段——个人贡献：

“我的改造重点是把原有能力产品化并增强数据工程闭环。我新增 PipelineRuntime，限制 HTTP 只能执行受控配置；用持久化 watermark 实现增量与幂等；新增管道状态和执行 API；把真实指标接入双语 Studio；增加质量失败按钮，构造一条更新但缺失必填字段的数据，验证 quarantine、发布阻断和 watermark 不推进。过程中还发现原子回滚会把 quarantine 元数据一起恢复，于是把不可变运行证据与可回滚发布状态分开持久化。”

第四段——结果和边界：

“目前首次运行可发布 5 行，二次运行发布 0 行，质量失败隔离 1 行并保持水位线 2026-01-03。项目有 252 项测试。当前边界是 SQLite、单进程锁和本地受控部署；生产化会优先增加 PostgreSQL adapter、异步状态机和迟到数据 upsert。”

## 15. 代码级调用链

### 15.1 从浏览器点击“运行管道检查”开始

完整调用顺序：

    PipelinesView.runPipelineCheck("standard")
    -> POST /api/queryforge/engineering/pipeline/run?scenario=standard
    -> Web 代理校验允许的固定路径并转发查询参数
    -> FastAPI pipeline_run()
    -> PipelineRuntime.run(scenario)
    -> 获取非阻塞进程内锁
    -> DataAssetBuilder.build_from_file()
    -> build_all()
    -> _build_asset()
    -> 读取、规范化、watermark 过滤、staging、quality、publish
    -> 语义模型生成与契约验证
    -> 记录不可变 run evidence
    -> PipelineRuntime.status() 聚合状态
    -> React 更新 DAG、质量、运行历史

面试表达重点：

- Web 路由不直接读文件或写 SQLite。
- FastAPI 路由不实现业务规则，只调用 application service。
- PipelineRuntime 是面向 Studio 的应用用例，不替代底层 builder。
- DataAssetBuilder 仍然负责真正的数据事务与语义发布。

### 15.2 质量失败调用链

    runPipelineCheck("quality_failure")
    -> PipelineRuntime 校验 scenario 白名单
    -> PipelineScenarioFactory 的当前轻量实现生成受控副本
    -> 在副本中追加 2026-01-04 的异常行
    -> watermark 过滤后只有该新行进入 staging
    -> required_columns 检查发现 anime_title 为空
    -> 写 quarantine
    -> invalid_ratio = 1 / 1，超过 0.05
    -> DataAssetError
    -> 发布检查点回滚
    -> watermark_after 恢复为 watermark_before
    -> 独立记录不可变审计证据
    -> API 返回 failed 状态及 run id

这里的关键不是“故意报错”，而是证明失败路径也有设计：

- 错误可解释。
- 问题行可定位。
- 对外数据不污染。
- 水位线不丢数据。
- 审计证据不消失。

### 15.3 状态查询调用链

PipelineRuntime.status() 聚合多个来源：

| 来源 | 用途 |
|---|---|
| 原始 CSV | 源行数和文件大小 |
| asset_watermarks | 当前成功 watermark |
| asset_lineage | 运行状态、行数、目标表、错误 |
| asset_quarantine | 问题行和失败原因 |
| semantic_contract_reports | 语义契约是否通过 |
| pipeline_run_evidence | 回滚后仍保留的不可变运行证据 |

这是一种 read model：前端不需要理解底层多张元数据表，只消费一个为展示优化的 PipelineStatus。

## 16. 数据库表逐张讲解

### 16.1 asset_watermarks

核心字段：

| 字段 | 含义 |
|---|---|
| asset_name | 资产唯一名称，也是当前主键 |
| watermark_value | 最后一次成功发布的位置 |
| run_id | 推进该 watermark 的运行 |
| updated_at | 更新时间 |

为什么 asset_name 是主键：

当前 demo 每个资产只有一个增量分区。生产环境可能扩展为 asset_name + partition_key 的联合唯一键。

为什么保存 run_id：

可以回答“这个水位线是哪次运行推进的”，便于审计和回滚分析。

### 16.2 asset_lineage

它既保存运行摘要，也保存资产级血缘证据：

- source_type / source_location。
- target_table / publish_database。
- input、staged、published、quarantined 行数。
- watermark_before / watermark_after。
- status / error / created_at。

当前改进空间：

- 表名更准确可改为 asset_run_lineage。
- 增加 started_at、finished_at、duration_ms。
- status 应使用受约束枚举。
- 对 asset_name + created_at 建立基于真实查询模式的索引。

### 16.3 asset_quarantine

保存：

- 哪次运行。
- 哪个资产。
- 失败原因。
- 原始问题记录 JSON。
- 记录时间。

为什么保留原始记录而不只保留错误：

只有错误摘要无法修复数据。原始记录能帮助数据开发定位上游字段、值和批次。

安全注意：

生产环境的 quarantine 可能含个人信息，必须做访问控制、脱敏、保留期和删除策略。

### 16.4 semantic_catalog

保存资产与目标表、物理列和语义定义之间的关系。它让发布资产不仅“有表”，还带有可查询业务含义。

### 16.5 semantic_contract_reports

保存模型名、模型路径、是否通过以及报告 JSON。它回答“本次发布时使用的语义契约是否有效”。

### 16.6 pipeline_run_evidence

这是二次开发新增的不可变证据表：

- run_id 唯一。
- scenario 标识正常或受控失败场景。
- result_json 保存完整结果快照。
- quarantine_json 保存失败证据。
- created_at 保存证据时间。

为什么不能只依赖 asset_quarantine：

发布检查点回滚的目标是恢复一致的发布状态。如果 quarantine 与发布状态在同一检查点内，也可能一起恢复。审计日志的生命周期与发布状态不同，因此需要分离。

更成熟的实现：

- append-only，不允许 update。
- 使用独立审计数据库或日志系统。
- 对证据做哈希或签名。
- 设置留存期和访问权限。
- 避免在 JSON 中长期保存不必要敏感数据。

## 17. 关键算法与复杂度

### 17.1 字段规范化

目标：

- 将空格和特殊字符转为稳定 snake_case。
- column_aliases 显式映射优先。
- 空字符串转 NULL。
- 推断 INTEGER、REAL 或 TEXT。

风险：

- 不同源字段规范化后可能名称冲突。
- 类型推断可能被少量异常样本误导。
- 日期仍可能以 TEXT 保存，需要统一格式契约。

生产改进：

- 先读取显式 schema contract。
- 推断只作为初稿。
- 检测列名冲突并阻断。
- 类型转换失败进入 quarantine，而不是静默转字符串。

### 17.2 唯一键检查

概念上需要比较：

- 当前批次内部是否重复。
- 与目标表已有键是否重复。

如果把目标表全部唯一键加载到内存，时间和内存大致随已有记录量增长。大表中应改为数据库侧 unique constraint、临时表 join 或 merge。

### 17.3 watermark 比较

当前比较依赖值能够稳定排序。ISO 日期 2026-01-03 的字符串字典序与时间顺序一致，但任意日期格式不一定成立。

生产要求：

- 明确 watermark 类型。
- 时区统一为 UTC。
- 对 null、非法值和同一时间多记录定义规则。
- 最好用复合水位线，例如 event_time + event_id，避免相同时间戳丢记录。

### 17.4 invalid ratio

当前：

    invalid_ratio = quarantined_rows / staged_rows

只有本次增量进入分母。如果 1 条新增数据失败，则比例为 100%，即使历史数据全部正常，也应阻断本批发布。这比用全历史数据稀释错误更合理。

边界情况：

- staged_rows 为 0 时比例定义为 0。
- warning 是否计入 quarantined 需要明确。
- 多规则命中同一行时应避免重复计算问题行。

## 18. 事务、一致性和可靠性深挖

### 18.1 这里的一致性指什么

不是分布式系统中的全局强一致，而是本地发布边界内保证：

- 目标数据版本完整。
- 语义模型与目标数据版本匹配。
- watermark 只指向已发布数据。
- 失败运行有审计证据。

### 18.2 exactly-once 与幂等的区别

不要轻易说“实现 exactly-once”。

当前实现更准确地说是：

- watermark 控制增量输入。
- 重复运行在当前样例中不重复发布。
- 质量失败不推进水位线。

生产 exactly-once 往往需要源 offset、事务性写入、去重键和故障恢复共同保证。更实际的工程方法是 at-least-once 投递 + 幂等消费。

### 18.3 进程在哪些时刻崩溃会怎样

#### 读取后、staging 前

对外发布不变，watermark 不变，可以安全重跑。

#### staging 后、发布前

对外发布不变，watermark 不变。临时 staging 需要下一次覆盖或清理。

#### 发布中

依赖事务或检查点恢复旧版本。必须验证目标表和语义文件是否同时恢复。

#### 发布后、watermark 前

可能重读同批数据，因此目标侧唯一键和 upsert 是必要的第二道幂等保障。

#### watermark 后、响应前

客户端可能认为超时并重试。服务端必须让重试安全，不能依赖客户端只请求一次。

### 18.4 为什么锁使用非阻塞方式

非阻塞锁让第二个请求立即得到“已有运行”的明确反馈，而不是无限等待 HTTP 连接。

当前不足：

- 只保护单个 Python 进程。
- 服务重启后锁状态消失。
- 无 lease 超时。
- 无排队和优先级。

生产可使用数据库 advisory lock、Redis 带过期 lease 或调度器的并发策略。

## 19. SQL 安全深挖

### 19.1 多层防御

第一层：语义上下文只暴露允许的业务对象。  
第二层：生成提示要求单条只读 SELECT。  
第三层：解析 SQL AST，识别真实语法结构。  
第四层：校验表、列、函数、join 数、表数和 limit。  
第五层：DatabaseTool 再次验证只读。  
第六层：SQLite 以只读连接执行。  
第七层：限制返回行数和执行预算。

只依赖任何单层都不够。

### 19.2 为什么正则表达式不够

正则难以正确处理：

- 注释和字符串中的关键字。
- CTE 嵌套。
- 子查询。
- 多语句。
- quoted identifier。
- 方言差异。

AST 能理解结构，但仍要配合数据库只读权限，因为解析器也可能有边界或方言差异。

### 19.3 常见攻击与防护

| 风险 | 防护 |
|---|---|
| DROP/UPDATE/INSERT | AST 拒绝写节点 + 只读连接 |
| 多语句拼接 | 只允许单条语句 |
| 查询未授权表 | allowlist |
| SELECT 敏感列 | column scope |
| 大量 JOIN | max_joins / max_tables |
| 无限制扫描 | limit 与 shape budget |
| 危险函数 | function allow/deny policy |
| 提示注入 | 模型之后仍有确定性校验 |

### 19.4 SQL 正确不等于语义正确

SQL 可以成功运行但回答错问题。例如把播放次数当独立用户数，或走错 Join Path。解决方式：

- 指标使用受治理 expression。
- 明确事实表 grain。
- 限制 allowed dimensions。
- 使用语义关系和 Join Path。
- 对结果做 semantic equivalence 评测。

## 20. NL2SQL 工作流逐节点

实际配置可以按问题复杂度选择部分节点，但核心职责包括：

### Subject selection

缩小业务主题范围，减少无关表进入上下文。

### Date parser

优先用确定性规则识别日期表达，复杂情况再使用模型兜底。这样常见日期不需要额外模型调用。

### Schema linking

把问题中的业务概念关联到候选表、字段和语义实体。它决定模型能看到什么，是降低幻觉的重要步骤。

### Skill selection / metric search

检索适用的本地提示技能和受治理指标，不允许技能覆盖安全规则或真实 schema。

### Tool loop

复杂问题可以执行有限、只读的观察工具，在生成最终 SQL 前获取证据。必须有次数和数据量预算。

### Candidate generation

可以生成 1–3 个候选，数量有硬上限。并行候选增加成本，因此不是默认越多越好。

### Deterministic selection

候选先通过 AST 和治理校验，再根据语义匹配、复杂度、历史相似度等信号评分。没有候选通过安全校验时不能“选一个最像的”继续执行。

### Execute

通过 DatabaseTool 只读执行，并捕获结构化错误。

### Reflect

检查 SQL 语义和结果质量，不把“SQL 成功执行”直接等同于“答案正确”。

### Fix / regenerate

在有限 retry budget 内根据执行错误或反思反馈修复。修复后的 SQL 必须重新通过所有安全检查。

### Output

输出数据、SQL、解释、运行证据和报告，而不是只返回自然语言结论。

## 21. API 合同详细讲解

### GET /engineering/pipeline/status

用途：页面初始化和状态刷新。

返回概念：

- name/source/target。
- source_rows/source_bytes。
- completed_runs/failed_runs。
- current watermark。
- last_run。
- quality summary。
- lineage。
- recent_runs。

为什么是 GET：

它不应改变业务状态。当前实现可能做惰性表初始化，这是内部技术细节；长期可在应用启动或迁移阶段完成。

### POST /engineering/pipeline/run

参数：

- scenario=standard。
- scenario=quality_failure。

为什么 scenario 必须白名单：

如果接受任意路径，HTTP 调用者可能读取不应访问的文件或执行未评审配置。

当前响应 200 且 payload.status 可以是 failed。面试时可以主动指出更严格的生产 API 可选择：

- 业务质量阻断仍返回 200/201，表示任务成功执行但业务结果 blocked。
- 或返回 422，同时必须保留 run id 和结构化结果。

关键是团队需要统一“HTTP 传输成功”和“数据任务成功”的语义。

### 错误码建议

| 场景 | 建议状态码 |
|---|---|
| 非法 scenario | 400 |
| 同一资产正在运行 | 409 |
| 请求已创建异步任务 | 202 |
| run id 不存在 | 404 |
| 数据质量阻断 | 200 + blocked，或团队约定的 422 |
| 后端依赖不可用 | 503 |

## 22. 前端架构追问

### 为什么用 React Context 做语言切换

语言是整个页面共享、变化频率低的 UI 偏好，Context 足够；localStorage 只保存设备偏好，不作为业务数据真相。

### 当前 page.tsx 为什么值得拆分

随着 Data Domains、Pipelines、Semantic、Ask 和 Runs 增长，单文件会造成：

- 评审范围过大。
- 状态依赖难追踪。
- 组件测试困难。
- 文案与业务逻辑混杂。

建议拆成 feature 目录，并将 API client、类型、i18n 字典和 formatter 独立。

### 为什么前端不直接访问 8000

通过同源代理可以：

- 避免浏览器 CORS 配置。
- 集中允许路由。
- 隐藏后端基地址。
- 统一超时和错误映射。

但代理不是认证系统。生产环境仍需要后端鉴权与授权。

## 23. 更完整的测试金字塔

### 单元测试

- normalize identifier。
- 类型推断。
- required/unique 质量规则。
- watermark 比较和最大值。
- SQL policy 每个规则。
- candidate selector 评分。

### 组件测试

- PipelineRuntime 状态聚合。
- 首次成功、幂等和质量失败。
- rollback 后证据仍存在。
- 非法 scenario。
- 并发锁冲突。

### 集成测试

- FastAPI status/run 合同。
- SQLite 文件、元数据和语义文件真实写入。
- 前端代理查询参数透传。
- PostgreSQL 未来使用 Testcontainers。

### 端到端测试

- 页面点击正常运行。
- 点击质量失败后出现 BLOCKED。
- quarantine 展示问题字段。
- watermark 在失败前后不变。
- 中英文切换不影响状态。

### 回归评测

NL2SQL 不能只测接口成功率，还应关注：

- SQL execution success。
- 结果集语义等价。
- policy violation rejection。
- candidate selection uplift。
- 修复次数和延迟。
- 不同数据域是否泄漏上下文。

## 24. 质量规则设计的深入回答

### 规则分类

结构规则：

- 必需列。
- 类型。
- 列名冲突。

行级规则：

- 非空。
- 范围。
- 枚举。
- 格式。

集合级规则：

- 唯一性。
- 行数波动。
- 分布漂移。
- 参照完整性。

业务规则：

- watch_seconds 不应小于 0。
- 订单完成时间不能早于创建时间。
- 收入必须对应有效业务状态。

### warning 与 blocking

不是所有异常都应阻断：

- warning：记录和告警，但允许发布。
- quarantine：排除问题行，其余可发布。
- blocking：整批不发布。

当前 max_invalid_ratio 是批次级 blocking threshold。未来规则应显式包含 severity、action、owner 和 version。

### 数据质量和数据观测区别

数据质量回答“是否满足已知规则”；数据观测还关注未知异常，例如体量骤降、分布漂移、新鲜度延迟和 schema 漂移。

## 25. 语义建模深入问题

### 什么是 grain

grain 是事实表每一行代表的业务事件或状态。例如 fact_watch_events 每行代表一次播放事件，event_id 是稳定业务标识。

grain 不清晰会导致：

- join 后重复。
- sum 被放大。
- count 与 count distinct 混淆。
- 指标无法验证。

### 维度与指标

维度用于分组和筛选，指标是受治理计算表达式。不是所有数值列都是指标；watch_seconds 是度量字段，uploaded_watch_hours 才是定义了聚合和单位的业务指标。

### Join Path 为什么重要

同一实体间可能存在多条物理连接路径。明确 Join Path 可以防止模型为了“连得上”而选择业务含义错误的路径。

### 语义版本如何与数据版本关联

理想设计应让每次发布包含：

- data_version。
- semantic_version。
- contract_version。
- run_id。

查询运行记录保存所使用版本，确保历史答案可复现。

## 26. 30 个追加追问与参考回答

### Q11：为什么不直接在目标表上校验？

目标表是对外服务边界。直接写入再校验会让查询者看到中间状态，也增加恢复难度。staging 允许先完成转换和检查，再做短事务发布。

### Q12：为什么失败行需要 JSON 保存？

源 schema 可能变化，JSON 能快速保留原始形态。但常用过滤字段应结构化，敏感字段需要脱敏，长期大规模存储可转到对象存储。

### Q13：watermark 用时间戳有什么问题？

相同时间戳可能有多行，严格大于会漏掉同一时间后到记录；时区和精度也可能不一致。可使用时间 + 稳定 ID 的复合水位线。

### Q14：如果源数据删除了怎么办？

watermark 追加模型无法自动感知删除。可使用 CDC tombstone、定期快照对账，或源表的 deleted_at 标记。

### Q15：如何处理 schema drift？

区分兼容与不兼容变化。新增可空列可生成待评审变更；删除列、改类型、改变主键应阻断，并输出 contract diff 和影响分析。

### Q16：如何避免小文件问题？

对象存储场景可按时间分区，定期 compaction，把大量小文件合并为合适大小的 Parquet 文件，并维护 manifest。

### Q17：数据量增大时为什么考虑 Parquet？

列式压缩、谓词下推和只读部分列更适合分析扫描。CSV 没有强 schema，解析成本高，也不利于压缩和分区统计。

### Q18：DuckDB 和 PostgreSQL 应该先选谁？

面向本地文件分析、Parquet 和单机 OLAP，DuckDB 更自然；面向服务化元数据、事务、并发和通用数据开发岗位，PostgreSQL 更有代表性。

### Q19：发布 replace 和 append 有什么区别？

replace 用新快照替换整个目标，简单但成本高；append 只追加增量，需要唯一键、watermark 和迟到数据策略。还可支持 merge/upsert。

### Q20：如何实现 SCD Type 2？

为维度记录增加 surrogate key、effective_from、effective_to、is_current。业务属性变化时关闭旧版本并插入新版本；事实表按事件时间关联正确维度版本。

### Q21：如何做数据对账？

比较源与目标的行数、关键指标和校验和；按分区记录 reconciliation result。行数相等不代表内容相同，所以关键字段 hash 和业务指标也要检查。

### Q22：如何设计重试？

先分类错误。网络超时等临时错误可指数退避；契约失败、缺列等确定性错误不应自动重复。每次 attempt 必须关联同一逻辑 run id。

### Q23：如何取消任务？

任务表保存 cancel_requested。worker 在阶段边界检查；数据库查询使用可取消连接或超时。不能承诺任意指令级即时取消。

### Q24：如何防止两个 worker 重复处理？

使用资产级 lease 或 advisory lock；获取锁时校验租约版本；目标写入仍保持业务键幂等，避免只依赖锁。

### Q25：为什么要同时有运行日志和指标？

日志适合单次问题细节，指标适合趋势与告警。run id 把日志、指标和审计记录关联起来。

### Q26：哪些指标最重要？

成功率、端到端延迟、freshness lag、输入/发布/隔离行数、invalid ratio、重试次数、watermark lag 和 SLA miss。

### Q27：如何设置告警？

告警应对应可行动问题。例如连续两次失败、freshness 超 SLA、输入行数较基线下降 80%、invalid ratio 超阈值。避免每个单行异常都通知。

### Q28：如何保护数据库凭据？

环境变量或密钥管理服务；仓库只保留变量名；账号采用最小权限；开发、测试、生产分离；日志不打印连接串。

### Q29：如何做多租户？

身份验证后将 tenant/domain id 注入服务端上下文；所有元数据查询带租户条件；数据库层使用独立 schema、数据库或 RLS；不能相信前端传来的 domain id。

### Q30：如何保证 API 幂等？

任务创建可接受 idempotency key；服务端将 key 与请求摘要绑定；相同 key 返回已有 run，不重复创建。数据处理本身仍需目标侧幂等。

### Q31：为什么需要人工审批计划？

复杂或昂贵查询即使只读也可能消耗大量资源。执行前展示涉及表、join、预估复杂度和指标口径，可让用户确认。

### Q32：候选 SQL 越多越好吗？

不是。候选越多延迟和成本越高，还扩大选择复杂度。当前上限 3，应通过评测判断候选带来的正确率提升是否值得。

### Q33：模型反思可靠吗？

反思仍是模型输出，不能作为安全边界。它只能提供语义质量信号或修复建议，修复后的 SQL 必须重新经过确定性校验和执行验证。

### Q34：如何防止跨数据域泄漏？

服务端根据当前授权域加载该域的 source、semantic model、policy 和 history；检索索引带 domain id；不在域不完整时回退到样例语义。

### Q35：如何评估语义正确性？

准备带 expected SQL 或 expected result 的 gold set，优先比较结果集语义等价，而不是 SQL 字符串完全相同。

### Q36：为什么使用 YAML 语义模型？

可读、可版本控制、适合 code review。缺点是大型团队编辑冲突和治理 UI 较弱，生产可把数据库作为事实源并导出 YAML。

### Q37：SQLite 只读连接能防所有风险吗？

不能。它主要防写入数据库文件；仍需防止超大查询、敏感数据读取、危险扩展函数和资源耗尽，因此还要策略、范围和预算。

### Q38：为什么运行历史只保留最近若干条？

API read model 限制返回量，避免页面无限增长。底层可以长期保存，接口应分页。当前最近 12 条是演示级上限。

### Q39：JSON 字段有什么取舍？

优点是快速保存不同版本 payload；缺点是约束弱、查询和索引困难。稳定查询字段应列式化，JSON 仅做完整快照。

### Q40：如果重新设计一次会改什么？

更早定义 PipelineRun 聚合和 repository 接口；把 demo scenario 与 runtime 拆开；API 一开始使用显式 schema；前端按 feature 拆分；同时准备 PostgreSQL 集成测试。

## 27. 故障排查题

### 场景 1：source_rows 是 1000，staged_rows 是 0

排查：

1. 当前 watermark 是否已经超过所有源数据。
2. watermark 字段类型和格式是否一致。
3. 时区是否错误。
4. 字段 alias 是否让 watermark 字段变成其他名称。
5. 是否存在 null watermark。

### 场景 2：staged_rows 很多，published_rows 为 0

可能：

- 全部进入 quarantine。
- 语义契约失败导致整批回滚。
- 目标唯一键冲突。
- 发布事务失败。
- 展示的是幂等运行，但 staged 逻辑异常，需要检查状态合同。

### 场景 3：watermark 推进但目标没有数据

这是严重一致性问题。立即停止后续调度，确认发布和水位线是否在同一事务/检查点边界；回退 watermark，并按业务键重放缺失批次。

### 场景 4：目标出现重复记录

检查：

- 业务唯一键是否正确。
- watermark 是否只依赖不唯一时间戳。
- 发布重试是否使用 append。
- 是否有多 worker 并发。
- 目标数据库是否存在 unique constraint。

### 场景 5：查询结果翻倍

优先检查事实表 grain 与 Join Path，而不是先怀疑模型。多对多 join 或维度重复通常会放大聚合。

### 场景 6：模型生成不存在的字段

检查 schema linking 是否加载正确域、prompt 是否过长截断、语义字段是否与物理列映射。安全层应在执行前或执行时拦截，修复预算内可重试。

### 场景 7：API 超时但任务可能成功

客户端不能直接重发一个非幂等请求。生产应返回 run id，客户端查询状态；同步版本至少需要 idempotency key。

## 28. 系统设计题：将项目扩展到生产

### 需求假设

- 100 个数据域。
- 每小时数百个批任务。
- 数据源包括 PostgreSQL、对象存储和 API。
- 单任务百万到千万行。
- 需要重试、取消、审计和权限。

### 推荐架构

    Web / CLI
        |
    API Gateway + Auth
        |
    Control Plane API
        |---- PostgreSQL metadata
        |---- Scheduler
        |---- Queue
                 |
              Workers
        |--------|---------|
    Connectors Transform Quality Publisher
        |                    |
    Source systems       Warehouse/Lake
        |
    Object storage for artifacts/quarantine

### 控制面与数据面

控制面：

- 资产配置。
- 运行状态。
- 权限。
- 调度。
- watermark。
- 质量和血缘元数据。

数据面：

- 实际读取、转换、校验和发布数据。

分离原因：

- API 不承载长任务。
- worker 可独立伸缩。
- 元数据查询不扫描业务数据。
- 失败隔离和资源限制更清晰。

### 元数据模型

建议实体：

- tenant。
- domain。
- data_source。
- asset。
- asset_version。
- pipeline_run。
- pipeline_attempt。
- stage_run。
- watermark。
- quality_result。
- quarantine_record。
- lineage_edge。
- semantic_model_version。

### 调度

- cron 或事件触发生成逻辑 run。
- 队列投递 asset + version + run id。
- worker 获取 lease。
- heartbeat 延长租约。
- 超时后可由其他 worker 接管。
- attempt 与逻辑 run 分离。

### 大数据处理

- 小表：数据库分页或批量读取。
- 文件：Parquet 分区 + predicate pushdown。
- 大规模转换：Spark/Flink/云数仓 SQL。
- 质量检查：优先下推到执行引擎，避免全部拉到 Python 内存。

### 可靠性

- at-least-once 任务投递。
- 业务主键幂等写入。
- 复合 watermark。
- 发布版本和 manifest。
- 状态机使用 compare-and-set。
- 审计日志 append-only。

### 安全

- OAuth/OIDC。
- RBAC 或 ABAC。
- 租户隔离。
- secret manager。
- 网络访问控制。
- quarantine 脱敏。
- SQL 查询预算和审计。

## 29. 项目中可主动承认的技术债

主动承认不是减分，关键是说明影响和解决顺序。

1. PipelineRuntime 还承担 demo scenario 构造，应拆分。
2. page.tsx 较大，应按 feature 拆组件。
3. API 缺少完整 Pydantic 响应模型。
4. 同步运行不适合长任务。
5. 进程内锁不支持多实例。
6. watermark 只有单值，不处理同时间戳和迟到数据。
7. JSON 审计字段不适合复杂查询。
8. quarantine 尚无脱敏和生命周期管理。
9. SQLite adapter 与业务流程仍可进一步解耦。
10. 缺少真实 PostgreSQL 集成测试和容器化启动。

推荐回答结构：

“我知道这个限制；它当前影响的是……；在作品集阶段我为什么接受它……；生产化我会按……顺序改造；验收方法是……。”

## 30. 行为面试回答模板

### 如何理解陌生代码库

回答结构：

1. 先运行已有测试建立安全网。
2. 从 README 和入口理解外部能力。
3. 沿一条真实调用链阅读。
4. 标记 domain、application、infrastructure 和 interface 边界。
5. 用小型测试验证理解。
6. 在不破坏核心 builder 的情况下增加 runtime。

### 如何处理发现的设计问题

可讲审计证据被回滚：

- 预期：质量失败后页面展示 quarantine。
- 现象：发布正确回滚，但问题行也消失。
- 定位：quarantine 与发布元数据共享检查点。
- 决策：发布状态与不可变审计证据生命周期不同。
- 修改：新增独立 evidence 持久化。
- 验证：断言失败后 evidence 存在且 watermark 不变。

### 如何保证改动没有破坏原项目

- 先跑针对性测试快速反馈。
- 再跑数据资产与 API 集成测试。
- 最后跑 252 项全量回归。
- 前端执行 ESLint、TypeScript 和生产构建。
- 保留原有接口默认行为，scenario 默认为 standard。

### 与原作者如何协作

诚实说明：

- 原作者是同事并已授权。
- 自己负责理解边界、提出增强方向、实现和验证。
- 保留项目来源说明。
- 对个人贡献有清晰文件和功能证据。

## 31. 容易答错的问题

错误：“我实现了 exactly-once。”  
正确：“当前通过 watermark 和幂等发布避免样例重复；生产 exactly-once 还需要源 offset、事务和恢复协议。”

错误：“用了 AST 就绝对安全。”  
正确：“AST 是一层，还要对象范围、预算、只读连接和最小权限。”

错误：“watermark 就是最大时间。”  
正确：“它是最后成功提交的位置；时间只是实现之一，还要处理相同时间和迟到数据。”

错误：“所有坏数据都应该阻断。”  
正确：“需要 warning、quarantine 和 blocking 分级。”

错误：“SQLite 不专业。”  
正确：“SQLite 适合本地可复现边界；知道何时迁移以及如何抽象更重要。”

错误：“测试 252 项，所以系统没有问题。”  
正确：“测试降低回归风险，但覆盖率数字不能证明生产可靠性；还缺真实负载、故障注入和 PostgreSQL 集成。”

## 32. 白板绘图顺序

面试官让画架构时，不要一开始画几十个框。

第一层：

    Source -> Pipeline -> Published Data -> NL2SQL -> Result

第二层展开 Pipeline：

    Extract -> Stage -> Quality -> Publish
                    -> Quarantine

第三层补控制信息：

    watermark / lineage / run evidence / semantic contract

第四层展开安全：

    LLM candidate -> AST policy -> read-only DB

最后说明当前与生产版本差异：

    synchronous local runtime
          |
          v
    queue + worker + PostgreSQL metadata + warehouse

## 33. 模拟面试脚本

### 第一轮：基础项目面

面试官：介绍一下项目。  
你：使用 60 秒版本。

面试官：你的贡献是什么？  
你：列 PipelineRuntime、API、真实状态、双语 Studio、质量失败、测试。

面试官：为什么需要 watermark？  
你：说明增量、成功提交位置和失败不推进。

面试官：怎么保证不重复？  
你：watermark + 唯一键/upsert，当前和生产边界分开说。

### 第二轮：深挖

面试官：进程在发布后、更新 watermark 前崩溃怎么办？  
你：可能重读，因此目标端必须幂等；进一步把发布版本与 watermark 置于同一事务边界。

面试官：为什么审计证据独立？  
你：发布回滚和审计留存生命周期不同。

面试官：一亿行怎么办？  
你：控制面/数据面分离、分区 Parquet/数仓计算、worker 调度，保留契约与幂等抽象。

### 第三轮：开放设计

面试官：让你两周生产化，先做什么？  
你：

1. 明确 SLA、数据量和数据源。
2. 抽 adapter，接 PostgreSQL。
3. 异步 run 状态机。
4. 目标侧 upsert 和复合 watermark。
5. Testcontainers 和故障测试。
6. Docker Compose、指标和部署文档。

## 34. 七天面试准备计划

### 第 1 天：项目全貌

- 背熟 15 秒、60 秒和 3 分钟介绍。
- 画两遍总架构。
- 明确个人贡献边界。

### 第 2 天：数据管道

- 手写 Extract、Stage、Quality、Publish 顺序。
- 解释 watermark、幂等、quarantine。
- 阅读 data_assets/pipeline.py。

### 第 3 天：失败与一致性

- 演示质量失败。
- 练习四个崩溃时点。
- 解释审计证据为什么独立。

### 第 4 天：语义与 NL2SQL

- 阅读 workflow_runner.py 和 sql_policy.py。
- 解释 grain、metric、Join Path。
- 练习 SQL 安全攻击场景。

### 第 5 天：扩展设计

- 画 PostgreSQL adapter。
- 画异步状态机。
- 准备迟到数据和 upsert 回答。

### 第 6 天：完整模拟

- 录制一次 8 分钟演示。
- 找出所有口头禅和停顿。
- 随机抽取 15 个 Q&A 回答。

### 第 7 天：轻量复习

- 跑一次测试。
- 确认本地演示。
- 只复习边界和易错点，不再临时加功能。

## 35. 面试官可能要求现场修改

### 修改质量阈值

找到 assets.yml 中 max_invalid_ratio，说明从 0.05 调整阈值的业务影响。不要为了让失败通过而随意放宽规则。

### 新增 required column

修改配置并新增测试，验证缺失列进入 quarantine。

### 增加 API 字段

先修改 PipelineStatus read model，再修改 TypeScript 类型和 UI，最后加 API 合同测试。

### 新增一种 source

不要直接在 PipelineRuntime 写大量 if/else。说明应新增 SourceReader adapter，并在 builder 的 source dispatch 中注册。

## 36. 可向面试官反问的问题

数据开发岗位：

- 团队主要是批处理、流处理还是湖仓一体？
- 数据质量规则由数据开发、分析师还是业务方维护？
- 当前使用什么调度、血缘和 Catalog 工具？
- 任务失败后的重试、补数和回滚流程是什么？
- 对实习生更看重 SQL、Python、数仓建模还是平台工程？

避免只问：

- 加班多不多。
- 面试结果什么时候出。
- 公司使用哪些“热门技术”。

可以在流程后期询问工作方式和成长，但技术面优先围绕真实工作。

## 37. 术语速查

| 术语 | 一句话解释 |
|---|---|
| staging | 发布前的隔离暂存区 |
| watermark | 最后成功处理的增量位置 |
| idempotent | 重复执行不会产生额外业务结果 |
| quarantine | 保存问题数据及原因的隔离区 |
| grain | 一行事实代表的业务含义 |
| semantic layer | 物理字段之上的业务实体和指标定义 |
| Join Path | 受允许和解释的表连接路径 |
| lineage | 数据从源到目标的依赖关系 |
| contract | 可版本化、可校验的数据与语义约束 |
| atomic publish | 只暴露完整旧版本或完整新版本 |
| rollback | 失败后恢复到上一稳定状态 |
| AST | SQL 的结构化语法树 |
| read-only | 执行账号和连接不能修改数据库 |
| upsert | 存在则更新，不存在则插入 |
| CDC | 捕获源数据库变更事件 |
| SCD Type 2 | 用多版本记录维度属性历史 |
| SLA | 服务承诺目标 |
| SLI | 衡量服务表现的指标 |
| retry budget | 允许的有限重试次数或成本 |

## 38. 最终答题原则

1. 先给结论，再讲实现，再说边界。
2. 区分“当前已经实现”和“生产化计划”。
3. 用真实数字：5 行、4/4、1 条隔离、watermark 2026-01-03、252 项测试。
4. 不把模型当安全边界。
5. 不把 watermark 等同 exactly-once。
6. 不回避 SQLite 和单进程锁限制。
7. 被问到不会的内容时，先说明未知点，再给验证方法。
8. 每个设计回答都尽量包含取舍，而不只是技术名称。
9. 始终清楚说明个人贡献。
10. 能现场操作和解释代码，比背诵长答案更有说服力。
