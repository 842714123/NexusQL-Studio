# Watermark 回看窗口与 Upsert：迟到数据处理详解

## 1. 为什么严格 Watermark 不够

严格增量通常使用：

```text
event_time > watermark_before
```

它简单、容易幂等，但隐含假设是数据永远按事件时间有序到达。真实业务中可能发生：

- 设备离线后补传昨天的事件；
- 上游延迟导致旧分区今天才到；
- 同一业务主键的金额或状态被修正；
- 多个事件拥有相同时间戳；
- 任务失败后上游重新发送部分记录。

如果只接受严格大于旧 Watermark 的记录，迟到数据会被永久跳过。

## 2. 当前实现

资产合同新增：

```yaml
watermark_field: occurred_at
watermark_lookback_seconds: 172800  # 向前回看 2 天
publish_mode: upsert
quality:
  required_columns: [id, occurred_at]
  unique_key: [id]
```

假设旧 Watermark 是 `2024-01-03`，回看两天，则本次有效下界是
`2024-01-01`。管道读取：

```text
occurred_at > 2024-01-01
```

因此 1 月 2 日和 1 月 3 日的迟到或修正记录会重新进入 Staging，1 月 1 日
及更早记录被有界窗口排除。窗口不是越大越好：窗口越大，重复读取和 Upsert
成本越高。

## 3. Watermark 为什么仍然只向前

回看改变的是“本次读取下界”，不是已经成功提交的 checkpoint。

```text
旧 Watermark: 2024-01-03
有效读取下界: 2024-01-01
本批最大合格时间: 2024-01-04
新 Watermark: 2024-01-04
```

如果本批只有 1 月 2 日的迟到记录，没有更新数据，新 Watermark 仍保持
`2024-01-03`。如果质量或语义门禁失败，Watermark 也保持原值。

## 4. 为什么回看必须配合 Upsert

回看会重复读取已经发布过的业务键。若继续普通 INSERT：

- 可能违反唯一约束；
- 或产生重复事实，导致聚合翻倍；
- 或把重复全部隔离，无法修正旧值。

Upsert 使用审核过的 `quality.unique_key`：

- 目标中不存在业务键：INSERT；
- 目标中已有业务键：UPDATE 非键字段；
- 同一输入批次出现重复键：仍进入 Quarantine；
- 唯一键为空：阻止发布。

系统会在 SQLite 目标表创建唯一索引，数据库层也参与保证业务键唯一，不能只依赖 Python 内存判断。

## 5. 运行证据

每次资产结果的 `details` 包含：

| 字段 | 含义 |
|---|---|
| `watermark_lookback_seconds` | 合同规定的回看秒数 |
| `watermark_effective_lower_bound` | 本次真正使用的下界 |
| `late_rows` | 时间不大于旧 Watermark、但落在回看窗口内的行数 |
| `inserted_rows` | 本次新增业务键数量 |
| `updated_rows` | 本次命中并修正已有业务键数量 |
| `watermark_before/after` | 成功 checkpoint 前后值 |

注意：`published_rows = inserted_rows + updated_rows` 表示本次写入尝试影响的
行数，不等于目标表净新增行数。

## 6. 示例

第一次输入：

```text
id | occurred_at | value
1  | 2024-01-02  | 10
2  | 2024-01-03  | 20
```

发布后 Watermark=`2024-01-03`。

第二次输入：

```text
id | occurred_at | value | 结果
1  | 2024-01-02  | 15    | 回看命中，UPDATE 10 -> 15
2  | 2024-01-03  | 20    | 回看命中，幂等 UPDATE
3  | 2024-01-04  | 30    | INSERT，并推进 Watermark
4  | 2024-01-01  | 40    | 不满足严格大于有效下界，忽略
```

最终目标表只有 id 1、2、3 三行，不会因为回看重复增长。

## 7. 与 Flink Watermark 的区别

这里是批处理 checkpoint 与回看窗口，不是 Flink 运行时 Watermark。

| 对比项 | 当前项目 | Flink |
|---|---|---|
| 场景 | 本地批处理增量 | 持续流处理 |
| Watermark 作用 | 记录上次成功处理位置 | 估计事件时间进度并触发窗口 |
| 迟到处理 | 下一批向前回看 | allowed lateness、side output 等 |
| 状态 | SQLite 元数据库 | Checkpoint/State Backend |
| 一致性 | 本地原子发布 + 业务键幂等 | Source/State/Sink 协调的一致性语义 |

面试时不能把本项目说成实现了 Flink Watermark，但可以说明两者都在处理事件时间、乱序和迟到问题，只是运行模型不同。

## 8. 当前边界

- 仅对 ISO 日期或时间戳启用秒级回看，非时间型 Watermark 会阻止执行；
- 目前每批仍把源文件读入内存，窗口只减少进入 Staging 的数据；
- Upsert 是 SQLite 实现，不是湖仓 MERGE；
- 只有单一 Watermark，尚未实现 `(event_time, event_id)` 复合游标；
- 相同时间戳的大量新键可能需要复合游标或文件清单；
- 没有按分区裁剪源文件，生产上应让 Source Adapter 下推时间条件。

## 9. 生产化演进

1. PostgreSQL 使用 `INSERT ... ON CONFLICT DO UPDATE`；
2. 湖仓使用 Iceberg/Delta/Hudi MERGE；
3. Source Adapter 把有效下界下推到 SQL WHERE 或分区读取；
4. Watermark 升级为 `(event_time, stable_id)` 复合游标；
5. 保存批次文件清单和内容哈希，避免重复文件；
6. 对 insert/update/no-change 分别计数；
7. 监控迟到分布，根据 P95/P99 延迟调整窗口，而不是拍脑袋配置。

## 10. 面试回答模板

### 为什么要加 Lookback

> 严格 Watermark 会漏掉晚于处理时间、但事件时间早于 checkpoint 的数据。我把本次读取下界向前移动一个有界窗口，再用业务主键 Upsert 消化重复和修正记录。持久化 Watermark 仍然只在整批成功后向前推进。

### Lookback 越大越好吗

> 不是。窗口越大，重复读取、质量检查和 Upsert 成本越高。我会根据上游迟到时长分布选择覆盖 P95 或 P99 的窗口，并对极端迟到进入补数流程。

### Upsert 如何保证唯一

> 批内先检查唯一键，目标表再创建数据库唯一索引；Upsert 使用相同业务键执行冲突更新。应用校验保证错误可解释，数据库约束提供最终兜底。

### 这是 Exactly Once 吗

> 不是分布式端到端 Exactly Once。它是在单机批处理边界内，通过 Watermark、业务键、唯一索引、Upsert 和原子回滚实现可重跑的目标状态幂等。

## 11. 测试证据

测试构造了首次发布、迟到修正、新记录和窗口外旧记录，验证：

- 迟到修正行能够进入 Staging；
- 已有业务键被更新而不是重复插入；
- 新键正常插入；
- 窗口外记录不进入目标表；
- Watermark 只从 `2024-01-03` 推进到 `2024-01-04`；
- 目标表最终只有三个唯一业务键。
