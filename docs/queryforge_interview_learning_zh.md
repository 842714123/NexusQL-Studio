# QueryForge 面试学习笔记

> 目标：以“能够结合真实代码讲清楚、能够应对追问”为标准学习 QueryForge。
>
> 维护方式：每完成一个学习板块，就补充核心流程、重点、难点、易错点、面试答案和自测题。

## 学习进度

| 板块 | 主题 | 状态 |
|---|---|---|
| 1 | 项目全貌与架构 | 已完成 |
| 2 | 数据管道一次运行的完整流程 | 已完成 |
| 3 | 数据源接入：CSV、Parquet、分页 JSON API | 已完成 |
| 4 | 标准化、Staging、质量校验与 Quarantine | 已完成 |
| 5 | Watermark、增量处理与幂等 | 已完成 |
| 6 | SQLite 发布、事务回滚与语义契约 | 待学习 |
| 7 | NL2SQL 工作流与语义层 | 待学习 |
| 8 | SQL AST 安全校验与只读执行 | 待学习 |
| 9 | FastAPI、前端工作台与可观测性 | 待学习 |
| 10 | 项目难点、局限、优化与综合面试演练 | 待学习 |

---

## 板块 1：项目全貌与架构

### 一句话介绍

QueryForge 是一个面向分析场景的数据工程与 NL2SQL 平台：它将 CSV、Parquet 或分页 JSON API 数据经过标准化、增量过滤、质量校验和受控发布，构建为 SQLite 分析资产；随后结合语义模型把自然语言问题转换为 SQL，通过安全校验后只读执行。

### 两条核心链路

1. 数据资产构建链路：`Source → Normalize → Watermark Filter → Staging → Quality → Quarantine/Publish → Semantic Contract`。
2. 查询链路：`Question → Semantic Context → SQL Generation → AST Validation → Read-only Execution → Result/Evidence`。 

两条链路的连接点是经过治理后发布的 SQLite 分析资产及其语义模型。

### 核心价值

- 不直接在未经校验的原始数据上进行 AI 查询。
- 用质量规则、异常隔离、Watermark 和失败回滚控制数据发布过程。
- 用语义模型约束表、字段、指标和业务口径。
- 用 SQL 结构校验和只读执行降低生成式 SQL 的风险。
- 保存运行状态、血缘、质量结果和执行证据，便于排查与追踪。

### “可治理”的准确边界

项目提供的是轻量级、工程化的治理能力，包括质量校验、异常隔离、状态管理、语义契约、SQL 安全和运行证据；它不是完整的企业级数据治理平台，不应声称已经具备元数据中心、权限中心、主数据管理、全域血缘或完整审计体系。

### 重点与难点

- 重点：数据资产构建和 NL2SQL 是两条链路，不要只把它介绍成“AI 生成 SQL”。
- 难点：解释为什么原始数据不能直接进入 NL2SQL——SQL 语法正确不等于数据和指标结果可信。
- 注意：当前项目是本地批处理和交互式查询，不是 Flink 实时流处理平台。
- 注意：项目中的 Watermark 是批处理高水位/检查点，不是 Flink 的事件时间 Watermark。

### 面试回答模板

> QueryForge 包含数据资产构建和自然语言查询两条链路。数据工程侧支持 CSV、Parquet 和分页 JSON API 接入，经过字段标准化、Staging、质量校验、异常隔离和 Watermark 增量处理后发布为 SQLite 分析资产；查询侧结合语义模型生成 SQL，再进行结构化安全校验和只读执行。项目的重点不是单纯生成 SQL，而是让数据从接入到查询的过程受到约束并且可以追踪。

---

## 板块 2：数据管道一次运行的完整流程

### 2.1 示例业务场景

项目内置 `anime_watch_events` 播放事件资产。CSV 中每行表示一次观看事件，包含：

- `Event ID`：事件唯一标识；
- `Anime Title`：动漫名称；
- `Watched At`：观看日期，也是增量 Watermark 字段；
- `Watch Seconds`：观看时长；
- `Device Type`：设备类型。

配置文件声明目标表为 `fact_watch_events`，要求 `event_id` 唯一，多个关键字段不能为空，最大坏数据比例为 5%，发布模式为默认的 `append`。

### 2.2 运行入口与职责分层

前端或调用方请求：

```text
POST /engineering/pipeline/run?scenario=standard
```

主要调用关系：

```text
FastAPI endpoint
  → PipelineRuntime.run()
  → DataAssetBuilder.build_from_file()
  → DataAssetBuilder.build_all()
  → DataAssetBuilder._build_asset()
```

各层职责：

- `PipelineRuntime`：控制同一进程内的并发运行、选择演示场景、组织返回值、读取并展示运行状态。
- `DataAssetBuilder`：执行真正的数据读取、转换、质量校验、发布、Watermark 和血缘记录。
- YAML 配置：声明数据源、目标表、字段别名、质量规则、增量字段及语义信息。

### 2.3 第 0 步：校验配置和人工审核门禁

`build_from_file()` 读取 YAML，并使用 Pydantic 模型进行严格校验。模型配置了 `extra="forbid"`，配置键拼错时不会被悄悄忽略，而是直接失败。

在整批构建开始前，代码还要求：

```yaml
semantic_model:
  reviewed: true
```

这表示实体粒度、隐藏字段、关系、Join Path 和指标定义需要经过人工确认。它是语义发布门禁，不是由系统自动证明业务口径正确。

### 2.4 第 1 步：创建批次检查点

`build_all()` 在处理资产前为已发布数据库和元数据创建检查点。一个配置可以包含多个资产，因此项目把数据表发布和语义模型发布视为一个批次。

目的：如果任意资产或语义契约失败，就恢复到运行前状态，防止出现“数据表更新了，但语义模型没有更新”或“部分资产成功、部分失败”的半成品状态。

### 2.5 第 2 步：生成 run_id 并读取旧 Watermark

每个资产运行会生成唯一的 `run_id`，用于关联血缘、Quarantine 和运行证据。

随后从元数据库的 `asset_watermarks` 表读取该资产上次成功位置：

```text
watermark_before = 上次成功发布的 watched_at 最大值
```

第一次运行没有历史状态，因此 `watermark_before = None`。

### 2.6 第 3 步：读取数据源

`read_source()` 根据配置选择读取器：

- CSV：使用 `csv.DictReader`；
- Parquet：使用 `pyarrow.parquet`；
- API：发送 JSON HTTP GET 请求，支持页码参数、最大页数和嵌套记录路径。

读取后的原始记录保存在内存中的 `list[dict]`，`input_rows` 记录本次从源端读到的总行数。

注意：当前实现不是流式读取，大文件可能占用较多内存；API 也是页式拉取后汇总到内存。

### 2.7 第 4 步：字段和值标准化

`normalize_record()` 对每一条原始记录进行确定性标准化：

1. 根据 `column_aliases` 映射业务字段名，例如 `Event ID → event_id`；
2. 将列名转换为小写下划线标识符；
3. 去除字符串首尾空格；
4. 空字符串转为 `None`；
5. 整数字符串转为 `int`，小数字符串转为 `float`；
6. 字典和列表转为稳定的 JSON 字符串。

这里的“标准化”主要是字段命名和基础值类型归一化，不应夸大为完整 ETL 清洗、复杂维表关联或业务指标加工。

### 2.8 第 5 步：按 Watermark 过滤增量

标准化后，只保留 Watermark 字段大于旧 Watermark 的记录：

```text
staged_rows = rows where watched_at > watermark_before
```

第一次运行 Watermark 为空，因此所有记录进入 Staging。第二次使用同一份源数据运行时，没有记录满足条件，所以 `staged_rows = 0`，最终 `published_rows = 0`。

这就是当前项目演示幂等性的主要机制：同一批历史数据重复运行，不会被重复追加。

### 2.9 第 6 步：写入 Staging

增量记录写入独立的 `staging.sqlite`，表名为：

```text
staging_anime_watch_events
```

Staging 是发布前的暂存层，便于把源数据读取与最终分析表发布分开。当前实现会替换本次资产的 Staging 表；如果没有增量记录，则删除旧 Staging 表，避免把上一次数据误认为本次输入。

### 2.10 第 7 步：质量校验与 Quarantine

代码先读取目标表中已有的唯一键，然后对本次 Staging 数据检查：

- 必填字段是否为空；
- 唯一键是否包含空值；
- 唯一键是否与本批前序记录或目标表历史数据重复。

不合格记录不会进入 `publishable`，而是连同失败原因写入元数据库的 `asset_quarantine` 表。

随后计算：

```text
invalid_ratio = quarantined_rows / staged_rows
```

只有当 `invalid_ratio > max_invalid_ratio` 时，才阻断本资产构建。当前示例阈值为 `0.05`，即 5%。

关键区别：

- 少量坏数据且比例未超过阈值：隔离坏记录，合格记录仍可继续发布；
- 坏数据比例超过阈值：整批失败，后续通过批次检查点回滚。

### 2.11 第 8 步：校验语义字段并发布 SQLite

发布前检查语义配置引用的字段是否真实存在。随后 `_publish()` 将合格数据写入 `published.sqlite` 的 `fact_watch_events` 表。

当前支持两种模式：

- `append`：保留历史数据并追加本次合格增量；
- `replace`：删除目标表后重建。

为了避免丢失历史数据，模型明确禁止 `watermark_field` 与 `publish_mode=replace` 同时使用。

发布时还会检查列顺序和已发布表结构；若与历史表结构不同，则以 schema drift 错误阻断，而不是自动修改表结构。

### 2.12 第 9 步：计算并保存新 Watermark

新 Watermark 从“本次通过质量校验、准备发布的记录”中计算：

```text
watermark_after = max(publishable.watched_at)
```

而不是简单取全部源数据或 Staging 数据的最大值。这样坏记录不会独自把进度推进到未来位置。

随后把 Watermark 和本次 `run_id` 写入 `asset_watermarks`。

### 2.13 第 10 步：生成并校验语义模型

所有资产构建成功后，系统先生成 `.pending.yml` 语义模型，然后执行语义契约校验。只有校验通过，pending 文件才替换正式语义模型。

这样可以避免 NL2SQL 使用一个引用不存在表、字段或错误关系的语义模型。

### 2.14 第 11 步：成功提交或失败回滚

成功时：

- 保留新发布的数据表；
- 保留更新后的 Watermark；
- 发布正式语义模型；
- 记录成功血缘和运行证据；
- 删除批次检查点。

失败时：

- 恢复发布数据库和元数据检查点；
- `published_rows` 归零；
- `watermark_after` 恢复为 `watermark_before`；
- 不发布正式语义模型；
- 记录失败运行证据，便于前端展示和排查。

### 2.15 三种运行结果

#### 第一次正常运行

```text
input_rows = 5
staged_rows = 5
published_rows = 5
watermark_before = None
watermark_after = 2026-01-03
status = success
```

#### 对同一份数据再次运行

```text
input_rows = 5
staged_rows = 0
published_rows = 0
watermark_before = 2026-01-03
watermark_after = 2026-01-03
status = success
idempotent = true
```

#### 运行质量失败演示

项目的失败场景会额外加入一条日期更新但 `anime_title` 为空的数据。该记录先进入 Quarantine；由于本次增量中坏数据占比超过 5%，批次失败，已发布数据和 Watermark 恢复到运行前状态。

### 2.16 本板块重点

1. 顺序必须会说：读取旧 Watermark → 读源 → 标准化 → 增量过滤 → Staging → 质量校验 → Quarantine → 发布 → 更新 Watermark → 语义契约 → 成功提交/失败回滚。
2. Watermark 只代表“最近成功发布到哪里”，失败运行不能推进它。
3. Quarantine 是行级异常隔离；质量阈值是批次级发布门禁，二者不是同一个概念。
4. SQLite 分成三类职责：`staging.sqlite` 暂存、`published.sqlite` 分析数据、`metadata.sqlite` 保存 Watermark/血缘/隔离记录/契约报告。
5. 数据和语义模型作为同一发布批次处理，避免二者版本不一致。

### 2.17 本板块难点

- **难点一：Watermark 更新时机。** 代码在资产处理过程中先保存新值，但外层有发布检查点；若后续语义契约失败，元数据会回滚，所以最终表现仍是失败不推进。
- **难点二：行级容错与批次阻断。** 不是出现坏数据就一定失败，而是坏数据先隔离，比例超过阈值才失败。
- **难点三：幂等的适用边界。** 当前主要依赖 Watermark 严格大于过滤和唯一键检查；它适用于新增记录的 append 场景，不等于已经实现任意更新、删除和迟到数据的完整 CDC。
- **难点四：内存与单机边界。** 源数据被整体加载到内存，并使用本地 SQLite，适合作品演示和中小数据量，不应声称能够直接承载企业级大数据吞吐。

### 2.18 易错表述与正确说法

| 容易说错 | 更准确的表达 |
|---|---|
| 有一条脏数据就整批失败 | 坏记录先进入 Quarantine，坏数据比例超过配置阈值才阻断批次 |
| Watermark 是最新读取时间 | Watermark 是最近一次成功发布的数据位置 |
| Staging 就是最终数据表 | Staging 是发布前暂存层，最终查询表位于 published SQLite |
| 项目实现了 CDC | 当前实现的是基于单字段高水位的 append 增量处理，不是完整 CDC |
| 项目支持海量数据 | 当前是单机内存处理和 SQLite 发布，重点是流程设计与治理机制 |
| 质量规则非常完善 | 当前行级规则主要覆盖必填和唯一键，语义契约另有范围等规则，仍可扩展 |

### 2.19 面试回答模板

> 一次管道运行首先读取 YAML 数据契约和上次成功 Watermark，然后从 CSV、Parquet 或分页 API 读取源数据，完成字段别名、列名和基础类型标准化。系统只把 Watermark 之后的新记录写入 Staging，再检查必填字段和唯一键。坏记录会写入 Quarantine；如果坏数据比例超过阈值，则阻断批次。合格数据发布到 SQLite 分析表，并以合格记录的最大增量字段计算新 Watermark。最后生成并校验语义模型。数据或语义任一环节失败，系统都会恢复发布检查点，因此 Watermark 不推进，也不会留下半发布状态。

### 2.20 高频追问

**问：为什么先做 Watermark 过滤，再做质量校验？**

答：质量校验针对本次待处理增量，避免每次重复校验全部历史数据；历史唯一键仍会从目标表读取，用于防止增量与已发布数据重复。

**问：坏记录已经进入 Quarantine，为什么还需要失败阈值？**

答：少量异常可以隔离后继续服务，但异常比例过高通常意味着源端、字段映射或整批数据发生系统性问题，此时继续发布会降低资产可信度，因此需要批次级门禁。

**问：为什么 Watermark 从 publishable 记录计算？**

答：如果从全部源数据计算，一条未成功发布的未来时间坏记录可能推进进度，修复后重跑时反而会被过滤，造成永久漏数。

**问：重复运行为什么不会重复写入？**

答：同一份数据的增量字段不大于已有 Watermark，因此不会进入 Staging；同时唯一键检查也会阻止与目标表历史键重复的数据。前者是主要增量过滤，后者是补充防线。

**问：这个方案有什么不足？**

答：单字段 Watermark 对同一 Watermark 值的迟到数据、历史记录更新和删除处理不足；生产方案可以使用复合游标、回看窗口加主键 Upsert，或接入数据库日志 CDC。

### 2.21 自测清单

在进入下一板块前，应能脱稿回答：

- 一次运行按什么顺序执行？
- `input_rows`、`staged_rows`、`published_rows` 有什么区别？
- Quarantine 和质量阈值分别解决什么问题？
- 为什么失败时 Watermark 不能推进？
- 第二次运行同一份 CSV 为什么发布 0 行？
- 三个 SQLite 文件分别保存什么？
- 当前增量方案为什么不等于完整 CDC？

### 2.22 课后追问：CSV 是否必须同时提供 YAML

当前实现中，执行数据资产构建确实需要一份 YAML 契约。CSV/Parquet 提供“实际数据”，YAML 提供“如何处理这些数据”的规则，两者职责不同：

- 源文件：列名和每一行记录；
- YAML：资产名、目标表、字段映射、Watermark 字段、质量规则、唯一键、发布模式和语义信息。

但不要求使用者完全从空白手写。项目提供 `scripts/scaffold_data_asset.py`，它可以抽样检查 CSV 或 Parquet，自动生成一份 YAML 草稿。使用者仍需人工确认业务粒度、唯一键、必填字段、Watermark、敏感字段、指标和语义，然后把 `semantic_model.reviewed` 改为 `true`。

推荐流程：

```text
提供 CSV/Parquet
→ 脚本读取样本并生成 YAML 草稿
→ 人工审核和补充业务规则
→ 执行构建
```

API 数据源没有本地 CSV 文件，但仍需要 YAML 或等价配置来声明 URL、认证环境变量、分页参数、记录路径及质量规则。

生产产品可以把 YAML 隐藏在表单后面：用户在界面选择唯一键、时间字段和质量规则，后端生成同样的配置。YAML 是配置载体，不是业务上必须让每个最终用户手写的形式。

### 2.23 课后追问：为什么需要 Watermark

没有 Watermark 时，如果源文件每天都包含截至当前的全部历史数据，管道每天都要重新处理全部数据。例如每天新增 10 万行，累计到 1 亿行后，不记录进度就可能每天重复扫描和校验 1 亿行。

Watermark 记录“上次成功发布到哪个位置”，下一次只处理更晚的数据，因此可以：

- 减少重复处理和计算开销；
- 避免 append 模式重复写入历史记录；
- 支持失败后从最近成功位置重跑；
- 形成可观察的处理进度。

Watermark 并非所有场景都必需。小型静态维表可以定期全量 `replace`；上游直接提供每日增量文件时，可以用文件清单/批次号记录已处理文件；数据库生产场景也可以使用更新时间、递增 ID、复合游标或日志 CDC。

当前项目的单字段严格大于方案存在边界：同一时间值的迟到数据可能被漏掉，历史更新和删除也无法完整表达。生产中常见改进包括：

- 使用 `(updated_at, primary_key)` 复合游标；
- 每次回看一个时间窗口，再按主键 Upsert 去重；
- 保存已处理文件清单；
- 使用 MySQL Binlog、Debezium、Flink CDC 等日志 CDC。

### 2.24 课后追问：SQLite 全量表会不会越来越大

会。`published.sqlite` 中保存历史数据加每次成功增量，从逻辑上看是截至当前的全量分析资产。Watermark 只减少每次需要处理的源端数据，不会自动缩小目标表。

当前实现使用 SQLite，是为了让作品可以零依赖、本地运行并完整演示数据接入、质量、增量、回滚、语义模型和 NL2SQL 闭环，而不是为了证明它能承载企业级海量数据。

SQLite 不提供 Hive/MaxCompute 那种原生分区表能力。可以建立普通索引、归档旧数据或按时间拆表，但手工拆表会增加跨表查询、语义建模和维护成本，不能等同于分布式数仓的分区裁剪。

数据规模增大后的分层方案：

1. **仍是单机中小数据量**：为日期、唯一键及常用过滤字段建立索引；只选择所需列；归档冷数据；定期维护数据库。
2. **单机分析型数据量增大**：把发布层替换为 DuckDB + 按日期分区的 Parquet，利用列式存储和分区裁剪。
3. **多用户并发和事务场景**：使用 PostgreSQL/MySQL，并按数据库能力设计索引和分区。
4. **真正的大数据离线数仓**：发布到 Hive、MaxCompute、Iceberg、Delta Lake 等，按日期/业务字段分区，通过 Spark/MaxCompute SQL 计算。
5. **实时增量场景**：使用 Kafka + Flink/Flink CDC，再写入湖仓或 OLAP 系统。

面试中的推荐说法：

> 当前发布层使用 SQLite，是为了降低本地演示和部署成本，并验证治理流程闭环。它保存的是历史加增量形成的当前全量资产，因此数据持续增长后确实会遇到容量、并发和扫描效率问题。SQLite 没有数仓式原生分区，短期可以通过索引和冷数据归档优化；如果面向更大离线数据，我会将发布层抽象为 DuckDB+分区 Parquet，或迁移到 Hive/MaxCompute/Iceberg，通过日期分区和列式存储实现分区裁剪。Watermark 解决的是增量处理问题，分区解决的是数据组织和查询扫描问题，两者不能互相替代。

### 2.25 第一次自测订正

#### input_rows、staged_rows、published_rows

- `input_rows`：从数据源实际读取到的总行数，包括历史数据和可能的坏数据。
- `staged_rows`：标准化后满足 `watermark_field > watermark_before` 的本次候选增量行数。
- `published_rows`：在 staged 数据中通过质量校验、并最终成功写入目标 SQLite 分析表的行数；如果批次后续失败回滚，最终报告中的该值归零。

通常有：

```text
published_rows <= staged_rows <= input_rows
```

示例：源文件 100 行，20 行位于 Watermark 之后，其中 2 行不合格但未超过质量阈值，则 `input_rows=100`、`staged_rows=20`、`published_rows=18`、`quarantined_rows=2`。

#### Quarantine 与质量阈值

- Quarantine 是行级机制：保存不合格记录及失败原因，使坏数据不进入正式表，并方便定位和修复。
- 质量阈值是批次级门禁：比较 `quarantined_rows / staged_rows` 与 `max_invalid_ratio`。未超过阈值时隔离坏数据并允许好数据发布；超过阈值时认为可能存在系统性问题，阻断并回滚整批。

#### Watermark 为什么从合格数据计算

Watermark 表示“成功发布到哪里”。如果从所有源数据或 staged 数据计算，一条未发布的未来位置坏记录可能推进 Watermark；该记录修复后重跑时又会因为不大于 Watermark 被过滤，造成永久漏数。因此只能基于本次可发布的合格数据计算，并且整批最终成功后才应保留该状态。

#### 同一 CSV 为什么不会重复写入

第一次成功运行后，Watermark 已经等于本批合格数据的最大增量字段值。第二次逐行判断时，同一 CSV 中的记录都不满足 `watermark_field > watermark_before`，因此 `staged_rows=0`、`published_rows=0`，Watermark 前后保持相同。

因果顺序应表述为：

```text
旧数据不大于 watermark_before
→ 被增量过滤排除
→ 没有待发布记录
→ watermark_after 保持等于 watermark_before
```

Watermark 前后相等是“没有新合格数据”的结果，而不是不写入的直接原因。唯一键与目标表历史键的比较是第二道去重防线。

---

## 板块 3：数据源接入——CSV、Parquet 与分页 JSON API

### 3.1 接入层在整体管道中的位置

数据源适配器只负责把不同来源读取成统一的内存结构：

```text
CSV / Parquet / JSON API
→ list[dict[str, Any]]
→ 后续统一执行标准化、Watermark、质量和发布
```

统一记录结构的价值是：后续管道不需要分别为三种源实现三套质量和发布逻辑。新增一种源时，理想情况下只需要新增适配器，并保持相同的输出契约。

入口是 `queryforge.data_assets.sources.read_source()`。`AssetSource.source_type` 使用 Pydantic `Literal["csv", "parquet", "api"]` 限定，因此当前直接支持且只支持这三类。

### 3.2 CSV 接入

配置示例：

```yaml
source:
  type: csv
  path: anime_watch_events.csv
```

处理步骤：

1. 相对路径在 `build_from_file()` 中按 YAML 所在目录解析为绝对路径；
2. 验证文件存在；
3. 使用 `utf-8-sig` 编码打开，兼容普通 UTF-8 和带 BOM 的 UTF-8；
4. 使用 `csv.DictReader`，第一行作为列名；
5. 每一行转换成字典，最终返回字典列表。

读取阶段的值基本还是字符串，数值、空字符串等基础类型转换发生在后续 `normalize_record()` 中。

当前边界：一次性把全部行放入列表，不是分块或流式读取；没有暴露分隔符、引号、编码和坏行策略配置；超大 CSV 可能造成内存压力。

### 3.3 Parquet 接入

配置示例：

```yaml
source:
  type: parquet
  path: events.parquet
```

处理步骤：

1. 验证文件存在；
2. 延迟导入 `pyarrow.parquet`；
3. 使用 `read_table()` 读取 Parquet 表；
4. 使用 `to_pylist()` 转换成字典列表。

Parquet 的优势：列式存储、压缩率通常更好、保留明确类型，适合分析数据交换。但当前实现仍然把完整 Parquet 转成 Python 列表，没有利用列裁剪、分区目录、谓词下推和批量迭代，所以不能仅因支持 Parquet 就声称已实现大数据优化。

`pyarrow` 是可选依赖；未安装时会返回明确错误，而不是让核心 CSV/API 功能依赖它。

### 3.4 分页 JSON API 接入

配置示例：

```yaml
source:
  type: api
  url: https://api.example.com/v1/orders
  headers:
    Authorization: Bearer ${ORDERS_API_TOKEN}
  params:
    status: completed
  records_path: data.records
  page_param: page
  page_size: 500
  max_pages: 100
```

字段含义：

- `url`：请求地址；
- `headers`：HTTP 请求头；
- `params`：每次请求携带的固定查询参数；
- `records_path`：从嵌套 JSON 中定位记录数组，例如 `data.records`；
- `page_param`：页码参数名称；
- `page_size`：预期每页记录数，也用于判断最后一页；
- `max_pages`：最多请求页数，防止接口异常导致无界请求。

分页过程：

```text
page = 1
→ GET ?page=1
→ 提取 data.records
→ 行数等于 page_size：继续
→ GET ?page=2
→ 行数小于 page_size：认为到达最后一页并停止
```

如果没有配置 `page_param`，只请求一次。无论是否到达短页，循环最多执行 `max_pages` 次。

响应必须能通过 `records_path` 定位到“JSON 对象数组”；路径不存在、结果不是数组、数组元素不是对象、请求失败或 JSON 解析失败都会阻断数据接入。

### 3.5 API 密钥为什么使用环境变量

配置允许 `${NAME}` 形式：

```yaml
headers:
  Authorization: Bearer ${ORDERS_API_TOKEN}
```

运行时从环境变量读取 `ORDERS_API_TOKEN`。这样 YAML 可以提交到代码仓库，而真实密钥不进入仓库。环境变量缺失时，程序直接报错。

注意：这只是最基础的秘密隔离方式；生产环境通常应使用云 Secret Manager、Vault 或平台凭证管理，并考虑密钥轮换和日志脱敏。

### 3.6 分页 API 的当前局限

- 只支持 GET，不支持 POST 请求体分页；
- 只支持页码式分页，不支持 cursor/next-token/Link header；
- 通过“返回行数小于 page_size”判断最后一页，依赖服务端行为与配置一致；
- 固定 30 秒超时，没有重试、指数退避、限流响应处理和断点续传；
- 各页最终全部聚合到内存；
- 没有显式校验 HTTP Content-Type；
- 如果 API 数据在运行过程中变化，页码分页可能出现重复或漏读；
- `max_pages` 防止无界抓取，但到达上限时当前实现不会额外提示数据是否被截断。

生产改进可以包括：游标分页、重试与退避、429 限流处理、请求幂等、分页检查点、落盘缓冲、响应 schema 校验和完整性指标。

### 3.7 为什么当前没有直接支持 TXT

TXT 只是文件扩展名，不能唯一说明数据结构。它可能是：

- 逗号分隔，实质上是 CSV；
- Tab 分隔的 TSV；
- 固定宽度文本；
- 每行一个 JSON 对象的 JSON Lines；
- 无结构日志或自然语言文本。

因此不能简单地把 `.txt` 当成一种固定表格源。合理扩展方式是新增 `delimited` 或 `jsonl` 适配器，并显式配置编码、分隔符、表头、转义和坏行策略。如果 TXT 本质是逗号分隔表格，也可以先按 CSV 读取或改用 `.csv`。

### 3.8 为什么当前没有直接支持 MySQL/PostgreSQL

当前 `AssetSource` 没有数据库连接类型，`read_source()` 也没有 JDBC/SQLAlchemy/MySQL 适配器，所以不能声称已经支持数据库直连。

数据库接入不仅是“执行一个 SELECT”这么简单，还要解决：

- 驱动和连接池；
- 凭证安全；
- 查询超时、重试和网络故障；
- 一致性快照，避免分页期间数据变化；
- 分批拉取，避免一次性加载全表；
- 增量列、复合游标或 CDC；
- 对源库的压力控制；
- 类型映射和时区；
- SQL 注入与允许读取的表范围。

最小扩展方案可以新增 `mysql` 适配器，要求只读连接、受控查询、`updated_at + primary_key` 复合游标和分批 `fetchmany()`；更成熟的增量方案则使用 Binlog CDC。

### 3.9 SQLite 在项目中的双重概念

当前管道没有把 SQLite 声明为可配置“源适配器”，但 SQLite 被用作：

- Staging 存储；
- 发布后的分析资产；
- Watermark、血缘、Quarantine 和契约报告的元数据存储；
- NL2SQL 的查询目标。

因此准确说法是：“当前可以把数据发布到 SQLite 并查询 SQLite，但数据资产接入层没有提供从任意外部 SQLite 数据库抽取的 source type。”二者不能混为一谈。

### 3.10 重点与难点

1. 三种数据源最终都转换为统一的 `list[dict]`，后续治理链路得以复用。
2. YAML 是数据源适配器的声明配置，不是数据本身。
3. CSV 读取结果主要是字符串；Parquet 通常保留更明确的物理类型。
4. API 的 `records_path` 负责定位记录数组，`page_param/page_size/max_pages` 控制有界分页。
5. 环境变量防止密钥明文进入 YAML，但不等于完整秘密管理系统。
6. “支持 Parquet”不等于“已经支持海量数据”，因为当前仍整体加载到内存。
7. “SQLite 是查询目标”不等于“SQLite 是已实现的数据源适配器”。

### 3.11 面试回答模板

> 数据接入层采用适配器思路，目前支持 CSV、Parquet 和分页 JSON API。三类适配器最终都输出统一的字典记录列表，因此后续字段标准化、增量过滤、质量校验和发布流程可以复用。CSV 使用 DictReader，兼容 UTF-8 BOM；Parquet 通过 PyArrow 读取；API 支持请求头、固定参数、嵌套 records_path、页码参数和最大页数，并通过环境变量注入认证信息。当前实现定位于本地批处理，数据会整体加载到内存，API 也暂未覆盖游标分页、重试限流和断点续传。MySQL 和外部 SQLite 直连目前尚未实现，如果扩展，我会抽象统一 SourceAdapter，并为数据库源增加只读连接、分批拉取、复合游标或 CDC。

### 3.12 高频追问

**问：为什么要把不同数据源转换成同一种结构？**

答：隔离来源差异，让标准化、质量、Watermark 和发布只依赖统一输入契约，避免每种源重复实现完整管道。

**问：API 为什么需要 max_pages？**

答：它是安全边界，避免服务端持续返回满页、分页参数失效或配置错误时产生无界请求；但当前到达上限不会提示截断，仍是可优化点。

**问：records_path 是什么？**

答：它是从嵌套 JSON 响应中找到记录数组的点分路径。例如响应为 `{"data":{"records":[...]}}`，就配置 `data.records`。

**问：为什么不用 Pandas 读取 CSV？**

答：当前目标是控制依赖并保持逻辑透明，标准库足以处理演示数据；如果需要分块、复杂类型推断或高性能处理，可以引入 PyArrow、Polars 等，但仍应避免无界加载。

**问：怎么支持 MySQL？**

答：增加实现统一输出契约的数据库 SourceAdapter，使用只读账号和连接池，查询白名单表，按 `updated_at + primary_key` 分批拉取并保存游标；大规模持续增量则优先考虑 Binlog CDC，而不是反复轮询全表。

### 3.13 易错表述

| 不准确表述 | 正确表述 |
|---|---|
| 项目支持各种文件上传 | 当前数据资产接入明确支持 CSV、Parquet 和分页 JSON API |
| 支持 SQLite 数据源 | 当前发布和查询目标是 SQLite，但未实现外部 SQLite source adapter |
| 支持数据库连接 | 当前未直接支持 MySQL/PostgreSQL 数据源 |
| API 支持各种分页 | 当前只支持简单页码分页和短页终止 |
| 支持 Parquet，所以能处理大数据 | 当前 Parquet 也整体转为内存列表，尚未实现分区/流式读取 |
| 环境变量绝对安全 | 环境变量避免密钥进入 YAML，但生产仍需专门的凭证管理和脱敏 |

### 3.14 自测题

1. 三种数据源为什么都要转换成 `list[dict]`？
2. CSV 读取和标准化分别负责什么？
3. `records_path`、`page_param`、`page_size`、`max_pages` 分别有什么作用？
4. API 密钥为什么不直接写入 YAML？
5. 当前分页 API 在可靠性上还缺少什么？
6. 为什么支持 Parquet 不等于支持海量数据？
7. 为什么不能说项目已经支持 MySQL 或 SQLite 数据源？
8. 如果让你扩展 MySQL 接入，至少需要考虑哪些问题？

---

## 板块 4：标准化、Staging、质量校验与 Quarantine

### 核心流程

```text
原始记录 → 字段和值标准化 → Watermark 过滤 → Staging
→ 行级质量检查 → publishable / Quarantine
→ 质量比例门禁 → 临时发布 → 整表语义契约 → 提交或回滚
```

字段名先应用 `column_aliases`，再转成 ASCII 小写下划线形式；值会去除首尾空格、将空字符串转为 `None`，并把简单整数和小数文本转成数值。它只是基础类型归一化，不是完整业务清洗；例如编码 `"00123"` 会变成整数 `123`，所以生产中应增加显式字段类型契约。

Staging 保存本次 Watermark 之后的候选增量，是发布前缓冲层，不是永久历史层。当前每次替换 `staging_<asset>` 表，没有增量时删除旧表。

### 两层质量机制

| 层次 | 配置位置 | 当前规则 | 处理结果 |
|---|---|---|---|
| 发布前行级质量 | `quality` | 必填字段、唯一键为空/重复 | 坏行进入 Quarantine；坏行比例超阈值则阻断 |
| 发布后资产契约 | `semantic.quality_rules` | 空值率、唯一、范围、外键 | 生成契约报告；错误级失败则整批回滚 |

范围异常（如 `watch_seconds < 0`）当前属于语义契约：它可能先进入临时目标表，随后契约失败并回滚，但不会自动逐行进入 Quarantine。这是当前实现边界，也可通过把确定性范围/枚举规则前移到行级检查来优化。

### 唯一键检查原理

系统先从正式目标表查询历史唯一键，转换为 Python `set`，再顺序遍历本次 staged 数据：

```text
历史 seen = {(evt-1001,), (evt-1002,)}
本批 evt-1002 → 已存在，Quarantine
本批 evt-1003 → 接受并加入 seen
本批再次 evt-1003 → 已存在，Quarantine
```

复合键 `[order_id, item_id]` 会组成 `(order_id, item_id)` 比较，因此同时识别跨批重复和批内重复。该实现会把全部历史键加载进内存，规模大时应改用数据库唯一约束、事务、反连接或 `MERGE/UPSERT`；应用层检查主要用于友好错误和异常隔离。

### 规则由谁定义

两层规则都需要执行前声明。脚手架可以从 CSV/Parquet 样本推荐候选字段、grain 和唯一键，但样本唯一不等于业务唯一；必填、范围、阈值、外键和指标口径仍需了解业务的人审核。`semantic_model.reviewed: true` 表示人工审核完成，不表示模型自动证明规则正确。

### 板块 4 面试回答

> 数据接入后先通过字段别名统一列名，并完成空白处理和基础类型转换；Watermark 之后的候选增量写入 Staging。发布前逐行检查必填字段和唯一键，异常记录进入 Quarantine，再通过坏数据比例决定批次能否继续。临时发布后还会执行空值率、范围、唯一性和外键等资产级语义契约，失败则恢复检查点。两层规则主要由人通过 YAML 确认，脚手架只负责生成候选草稿。

### 板块 4 易错点

- Quarantine 是行级隔离，质量阈值是批次门禁。
- Staging 是本次候选增量，不是全量历史仓库。
- 当前一行同时违反多条行级规则时只记录首先命中的原因。
- `raw_record_json` 实际保存的是标准化后的记录，而非原始文件字节。
- 当前没有 Quarantine 审核、修复和自动 replay 闭环。

---

## 板块 5：Watermark、增量处理、幂等与失败重跑

### 5.1 四个概念必须分开

- **增量处理**：只处理上次成功位置之后的新数据。
- **去重**：通过业务唯一键识别重复事实。
- **幂等**：相同输入重复执行，最终业务状态与执行一次一致。
- **失败重跑**：失败时不错误推进状态，修复后能重新处理未提交数据。

Watermark 主要划分增量范围；唯一键主要去重；检查点回滚防止半提交。三者组合形成当前项目有限范围内的幂等能力。

### 5.2 Watermark 如何保存与过滤

`metadata.sqlite` 的 `asset_watermarks` 按资产保存 `watermark_value`、推进它的 `run_id` 和更新时间。每个资产拥有独立 Watermark。

假设：

```text
watermark_before = 2026-01-03
```

标准化后只保留：

```text
watermark_field > watermark_before
```

质量合格记录发布后，从 `publishable` 中取最大字段值作为候选 `watermark_after`；没有新合格记录则保持旧值。

### 5.3 Watermark 的比较方式

代码先尝试将两端转为 `Decimal`，所以递增数字 ID 按数值比较；转换失败后按字符串字典序比较。ISO 固定宽度且时区一致的时间字符串通常顺序正确，但非补零日期、混合格式或混合时区不可靠。生产中应在契约中声明类型，并统一解析时间和时区。

### 5.4 同一 CSV 重跑为什么不重复发布

第一次成功后，Watermark 已是合格数据最大位置。第二次读取相同 CSV 时，没有记录严格大于旧值，因此：

```text
staged_rows = 0
published_rows = 0
watermark_after = watermark_before
```

目标表不再增加记录，历史唯一键检查还是第二道防线。API 中的 `idempotent=true` 仅表示所有资产成功且本次均发布 0 行，是演示指标，不是对任意管道幂等性的形式化证明。

### 5.5 失败后为什么 Watermark 不推进

批次开始前备份发布数据库和元数据库。资产处理中可能先保存候选 Watermark，再执行语义模型发布；若任意资产或语义契约失败，外层恢复检查点，最终结果设置为：

```text
status = failed
published_rows = 0
watermark_after = watermark_before
```

因此最终可见状态仍满足“只有整个批次成功才推进”。失败证据单独保留，既能展示失败，又不破坏可重跑状态。

### 5.6 append 与 replace

- `append`：保留历史并追加合格增量，适合 Watermark。
- `replace`：删除后重建全表，适合小型全量快照。

项目禁止 `watermark_field + publish_mode=replace`，因为只读取增量后替换整表会丢失历史数据。

### 5.7 当前单字段方案的边界

- **同值迟到数据**：上次已到时间 T，后来新增另一条时间也为 T 的记录，严格 `>` 会漏掉。
- **历史更新**：内容变化但 Watermark 字段未增大时不会重处理。
- **删除事件**：append 高水位无法表达源端删除。
- **格式问题**：非统一日期和时区可能导致字符串顺序错误。
- **空 Watermark 字段**：已有 Watermark 后，该行会在质量检查前被过滤，可能无法进入 Quarantine。

所以当前实现不是完整 CDC。

### 5.8 生产级改进

#### 复合游标

```sql
WHERE updated_at > :last_time
   OR (updated_at = :last_time AND id > :last_id)
ORDER BY updated_at, id
```

保存 `(updated_at, id)` 可以处理多条记录共享同一时间值。

#### 回看窗口 + Upsert

每次从 Watermark 向前回看一段时间，允许迟到记录和部分重复输入，再按主键 `MERGE/UPSERT`。回看增加重复计算，但提高迟到容忍能力。

#### 文件清单

每日增量文件场景可以记录文件名、大小、校验和和批次状态，不必只依赖内容中的时间字段。

#### 日志 CDC

MySQL Binlog、Debezium、Flink CDC 可捕获插入、更新和删除，适合持续同步；仍需处理 checkpoint、重复消息、下游幂等与 schema evolution。

### 5.9 能否声称 exactly-once

不能。当前通过本地检查点、单进程锁、Watermark 和唯一键检查，实现本地单进程批处理边界内的可重跑和目标状态幂等；它没有分布式事务、消息队列 checkpoint、跨进程互斥和数据库唯一约束兜底，不是 Flink/Kafka 语境下的端到端 exactly-once。

### 5.10 板块 5 面试回答

> 项目为每个资产维护独立 Watermark，表示最近成功发布的位置。运行时只保留增量字段严格大于旧值的记录；合格数据发布后，再以其最大值形成新 Watermark。数据或语义契约失败时恢复发布库和元数据库检查点，因此进度不推进。相同输入重跑时没有记录进入 Staging，唯一键还提供第二层去重。不过当前是单字段 append 高水位方案，不能完整处理同值迟到、历史更新和删除；生产中可以使用复合游标、回看窗口加 Upsert，或日志 CDC。

### 5.11 高频追问

**问：Watermark 和唯一键有什么区别？**

答：Watermark 划分本次增量范围，唯一键判断业务记录是否重复。前者减少重复处理，后者保护目标数据唯一性。

**问：为什么不能只用唯一键？**

答：虽然可以识别重复，但每次仍可能读取并比较全部历史源数据；Watermark 能缩小处理范围。

**问：为什么不能只用 Watermark？**

答：相同业务记录可能带着更新的时间再次发送，回看窗口也会主动引入重复；Watermark 不识别业务身份，仍需唯一键或 Upsert。

**问：这是 exactly-once 吗？**

答：不是分布式端到端 exactly-once；它只是在本地单进程边界内实现失败可重跑和目标状态幂等。

### 5.12 重点与易错点

1. Watermark 是成功发布位置，不是最大读取位置。
2. 增量、去重、幂等、失败重跑是四个不同概念。
3. `watermark_after == watermark_before` 是没有新合格发布数据的结果。
4. 严格 `>` 会漏掉同值迟到记录。
5. Watermark 不处理历史更新和删除。
6. 本地备份恢复不是分布式事务或 exactly-once。
7. ISO 时间字符串按字典序比较存在格式和时区前提。

### 5.13 自测题

1. 增量处理、去重和幂等分别是什么？
2. 为什么既需要 Watermark 又需要唯一键？
3. 资产处理中先保存了候选 Watermark，后续契约失败时为什么最终仍不推进？
4. 相同时间戳的迟到数据为什么可能漏掉？
5. 复合游标如何解决同时间值问题？
6. 回看窗口为什么必须配合 Upsert？
7. `append` 和 `replace` 分别适合什么场景？
8. 为什么当前项目不能声称 exactly-once？
