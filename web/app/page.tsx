"use client";

import {
  ChangeEvent,
  createContext,
  FormEvent,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

type View = "domains" | "overview" | "sources" | "pipelines" | "semantic" | "ask" | "runs";
type ConnectionState = "checking" | "live" | "demo";
type SemanticTab = "graph" | "metrics" | "paths";
type Language = "en" | "zh";

const LanguageContext = createContext({
  language: "en" as Language,
  text: (english: string, chinese: string) => english || chinese,
});

function useLanguage() {
  return useContext(LanguageContext);
}

type Entity = {
  name: string;
  table: string;
  label: string;
  kind: "dimension" | "fact" | "bridge";
  owner: string;
  grain: string;
  dimensions: number;
  metrics: number;
  x: number;
  y: number;
};

type Metric = {
  name: string;
  label: string;
  entity: string;
  aggregation: string;
  expression: string;
  description: string;
};

type QueryResult = {
  status: string;
  runId: string;
  explanation: string;
  sql: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  rowCount: number;
};

type RunRecord = {
  id: string;
  domainId: string;
  question: string;
  status: "Passed" | "Blocked" | "Running";
  model: string;
  rows: number;
  duration: string;
  time: string;
};

type UploadedSource = {
  id: string;
  domainId: string;
  name: string;
  type: string;
  size: string;
  tables: number;
  rows: string;
  status: "Ready" | "Draft";
};

type DataDomain = {
  id: string;
  name: string;
  slug: string;
  description: string;
  owner: string;
  status: "ready" | "draft";
  isSample: boolean;
  sourceCount: number;
  runCount: number;
};

type SemanticDraft = {
  entity: string;
  description: string;
  owner: string;
  grain: string;
  primaryKey: string;
  sensitivity: "public" | "internal" | "restricted";
  dimensions: string[];
  metrics: Array<{
    name: string;
    description: string;
    aggregation: "count" | "sum";
    expression: string;
  }>;
};

type PipelineRun = {
  run_id: string;
  input_rows: number;
  staged_rows: number;
  published_rows: number;
  quarantined_rows: number;
  watermark_before: string | null;
  watermark_after: string | null;
  status: string;
  error: string | null;
  created_at: string;
  quarantine: Array<{
    reason: string;
    record: Record<string, unknown>;
    created_at: string;
  }>;
};

type PipelineStatus = {
  name: string;
  source_rows: number;
  source_bytes: number;
  completed_runs: number;
  failed_runs: number;
  watermark: { value: string; updated_at: string } | null;
  last_run: PipelineRun | null;
  quality: {
    passed: boolean;
    checks_passed: number;
    checks_total: number;
    quarantined_rows: number;
    failures: string[];
  };
  lineage: {
    source: string;
    staging: string;
    target: string;
    semantic_model: string;
  };
  recent_runs: PipelineRun[];
};

const SAMPLE_DOMAIN_ID = "domain_anime_streaming";

const INITIAL_SEMANTIC_DRAFT: SemanticDraft = {
  entity: "uploaded_record",
  description: "One governed business record represented by the uploaded source.",
  owner: "workspace-admin",
  grain: "record_id",
  primaryKey: "record_id",
  sensitivity: "internal",
  dimensions: ["record_id", "entity_id", "recorded_at"],
  metrics: [
    {
      name: "uploaded_record_count",
      description: "Count of reviewed records at the declared grain.",
      aggregation: "count",
      expression: "COUNT(*)",
    },
    {
      name: "uploaded_amount_sum",
      description: "Sum of the profiled amount field in source-native units.",
      aggregation: "sum",
      expression: "SUM(amount)",
    },
  ],
};

const NAV_ITEMS: Array<{
  id: View;
  label: Record<Language, string>;
  caption: Record<Language, string>;
  icon: string;
}> = [
  { id: "domains", label: { en: "Data Domains", zh: "数据域" }, caption: { en: "Create & switch context", zh: "创建与切换业务上下文" }, icon: "◎" },
  { id: "overview", label: { en: "Overview", zh: "总览" }, caption: { en: "Workspace health", zh: "工作区健康状态" }, icon: "◇" },
  { id: "sources", label: { en: "Data Sources", zh: "数据源" }, caption: { en: "Ingest & profile", zh: "接入、剖析与发布" }, icon: "▦" },
  { id: "pipelines", label: { en: "Data Pipelines", zh: "数据管道" }, caption: { en: "Build & observe", zh: "构建与可观测性" }, icon: "⇢" },
  { id: "semantic", label: { en: "Semantic Studio", zh: "语义工作台" }, caption: { en: "Model & govern", zh: "建模与治理" }, icon: "⌘" },
  { id: "ask", label: { en: "Ask & Analyze", zh: "问答分析" }, caption: { en: "Query with evidence", zh: "基于证据查询" }, icon: "✦" },
  { id: "runs", label: { en: "Run History", zh: "运行历史" }, caption: { en: "Trace every decision", zh: "追踪每次决策" }, icon: "↺" },
];

const INITIAL_DOMAINS: DataDomain[] = [
  {
    id: SAMPLE_DOMAIN_ID,
    name: "Anime Streaming",
    slug: "anime-streaming",
    description:
      "Synthetic streaming analytics showcase spanning content, engagement, subscriptions, advertising, and merchandise.",
    owner: "Content analytics",
    status: "ready",
    isSample: true,
    sourceCount: 1,
    runCount: 5,
  },
];

const ENTITIES: Entity[] = [
  {
    name: "studio",
    table: "dim_studio",
    label: "Studio",
    kind: "dimension",
    owner: "content-analytics",
    grain: "studio_id",
    dimensions: 4,
    metrics: 0,
    x: 24,
    y: 42,
  },
  {
    name: "anime",
    table: "dim_anime",
    label: "Anime",
    kind: "dimension",
    owner: "content-analytics",
    grain: "anime_id",
    dimensions: 9,
    metrics: 0,
    x: 222,
    y: 42,
  },
  {
    name: "genre",
    table: "dim_genre",
    label: "Genre",
    kind: "dimension",
    owner: "content-analytics",
    grain: "genre_id",
    dimensions: 3,
    metrics: 0,
    x: 420,
    y: 16,
  },
  {
    name: "anime_genre",
    table: "bridge_anime_genre",
    label: "Anime Genre",
    kind: "bridge",
    owner: "content-analytics",
    grain: "anime_id + genre_id",
    dimensions: 2,
    metrics: 0,
    x: 420,
    y: 94,
  },
  {
    name: "episode",
    table: "dim_episode",
    label: "Episode",
    kind: "dimension",
    owner: "content-analytics",
    grain: "episode_id",
    dimensions: 5,
    metrics: 0,
    x: 222,
    y: 160,
  },
  {
    name: "watch_session",
    table: "fact_watch_session",
    label: "Watch Session",
    kind: "fact",
    owner: "engagement-analytics",
    grain: "watch_session_id",
    dimensions: 5,
    metrics: 3,
    x: 420,
    y: 184,
  },
  {
    name: "ad_impression",
    table: "fact_ad_impression",
    label: "Ad Impression",
    kind: "fact",
    owner: "ads-analytics",
    grain: "impression_id",
    dimensions: 5,
    metrics: 2,
    x: 624,
    y: 124,
  },
  {
    name: "user",
    table: "dim_user",
    label: "User",
    kind: "dimension",
    owner: "growth-analytics",
    grain: "user_id",
    dimensions: 7,
    metrics: 0,
    x: 24,
    y: 272,
  },
  {
    name: "rating",
    table: "fact_rating",
    label: "Rating",
    kind: "fact",
    owner: "engagement-analytics",
    grain: "rating_id",
    dimensions: 4,
    metrics: 1,
    x: 222,
    y: 272,
  },
  {
    name: "subscription",
    table: "fact_subscription",
    label: "Subscription",
    kind: "fact",
    owner: "monetization-analytics",
    grain: "subscription_id",
    dimensions: 4,
    metrics: 2,
    x: 24,
    y: 386,
  },
  {
    name: "user_follow",
    table: "fact_user_follow",
    label: "User Follow",
    kind: "fact",
    owner: "community-analytics",
    grain: "follow_id",
    dimensions: 1,
    metrics: 1,
    x: 222,
    y: 386,
  },
  {
    name: "merch_product",
    table: "dim_merch_product",
    label: "Merch Product",
    kind: "dimension",
    owner: "commerce-analytics",
    grain: "product_id",
    dimensions: 4,
    metrics: 0,
    x: 420,
    y: 342,
  },
  {
    name: "merch_order",
    table: "fact_merch_order",
    label: "Merch Order",
    kind: "fact",
    owner: "commerce-analytics",
    grain: "order_id",
    dimensions: 3,
    metrics: 0,
    x: 624,
    y: 300,
  },
  {
    name: "merch_order_item",
    table: "fact_merch_order_item",
    label: "Order Item",
    kind: "fact",
    owner: "commerce-analytics",
    grain: "order_item_id",
    dimensions: 2,
    metrics: 2,
    x: 624,
    y: 410,
  },
  {
    name: "calendar",
    table: "dim_date",
    label: "Calendar",
    kind: "dimension",
    owner: "data-platform",
    grain: "date_key",
    dimensions: 7,
    metrics: 0,
    x: 420,
    y: 456,
  },
];

const METRICS: Metric[] = [
  {
    name: "watch_hours",
    label: "Watch hours",
    entity: "watch_session",
    aggregation: "SUM",
    expression: "SUM(fact_watch_session.watch_seconds) / 3600.0",
    description: "Total valid viewing time, normalized to hours.",
  },
  {
    name: "completion_rate",
    label: "Completion rate",
    entity: "watch_session",
    aggregation: "RATIO",
    expression:
      "SUM(fact_watch_session.completed_flag) / NULLIF(COUNT(*), 0)",
    description: "Share of valid watch sessions completed.",
  },
  {
    name: "unique_viewers",
    label: "Unique viewers",
    entity: "watch_session",
    aggregation: "COUNT DISTINCT",
    expression: "COUNT(DISTINCT fact_watch_session.user_id)",
    description: "Distinct viewers with a valid watch session.",
  },
  {
    name: "average_rating",
    label: "Average rating",
    entity: "rating",
    aggregation: "RATIO",
    expression: "SUM(fact_rating.score) / NULLIF(COUNT(*), 0)",
    description: "Average submitted anime rating.",
  },
  {
    name: "subscription_revenue",
    label: "Subscription revenue",
    entity: "subscription",
    aggregation: "SUM",
    expression: "SUM(fact_subscription.recognized_revenue_usd)",
    description: "Recognized subscription revenue in USD.",
  },
  {
    name: "active_subscribers",
    label: "Active subscribers",
    entity: "subscription",
    aggregation: "COUNT DISTINCT",
    expression: "COUNT(DISTINCT fact_subscription.user_id)",
    description: "Distinct users represented by active subscriptions.",
  },
  {
    name: "ad_revenue",
    label: "Ad revenue",
    entity: "ad_impression",
    aggregation: "SUM",
    expression: "SUM(fact_ad_impression.revenue_usd)",
    description: "Revenue attributed to governed ad impressions.",
  },
  {
    name: "ad_click_through_rate",
    label: "Ad CTR",
    entity: "ad_impression",
    aggregation: "RATIO",
    expression:
      "SUM(fact_ad_impression.clicked_flag) / NULLIF(COUNT(*), 0)",
    description: "Click-through rate across eligible impressions.",
  },
  {
    name: "merch_gmv",
    label: "Merch GMV",
    entity: "merch_order_item",
    aggregation: "SUM",
    expression: "SUM(fact_merch_order_item.net_amount_usd)",
    description: "Net merchandise value in USD.",
  },
  {
    name: "merch_units",
    label: "Merch units",
    entity: "merch_order_item",
    aggregation: "SUM",
    expression: "SUM(fact_merch_order_item.quantity)",
    description: "Total merchandise units purchased.",
  },
  {
    name: "community_follows",
    label: "Community follows",
    entity: "user_follow",
    aggregation: "COUNT",
    expression: "COUNT(DISTINCT fact_user_follow.follow_id)",
    description: "Distinct user-follow relationships created.",
  },
];

const JOIN_PATHS = [
  {
    name: "watches_to_anime_via_episode",
    label: "Watch → Anime",
    steps: ["Watch session", "Episode", "Anime"],
    hops: 2,
    risk: "Safe",
  },
  {
    name: "watches_to_studio_via_episode_anime",
    label: "Watch → Studio",
    steps: ["Watch session", "Episode", "Anime", "Studio"],
    hops: 3,
    risk: "Safe",
  },
  {
    name: "watches_to_release_date_via_episode",
    label: "Watch → Release date",
    steps: ["Watch session", "Episode", "Calendar"],
    hops: 2,
    risk: "Safe",
  },
  {
    name: "merch_items_to_anime_via_product",
    label: "Order item → Anime",
    steps: ["Order item", "Merch product", "Anime"],
    hops: 2,
    risk: "Safe",
  },
  {
    name: "merch_items_to_user_via_order",
    label: "Order item → User",
    steps: ["Order item", "Merch order", "User"],
    hops: 2,
    risk: "Safe",
  },
  {
    name: "merch_items_to_date_via_order",
    label: "Order item → Date",
    steps: ["Order item", "Merch order", "Calendar"],
    hops: 2,
    risk: "Safe",
  },
  {
    name: "ads_to_studio_via_anime",
    label: "Ad → Studio",
    steps: ["Ad impression", "Anime", "Studio"],
    hops: 2,
    risk: "Safe",
  },
];

const GRAPH_LINKS = [
  { x: 144, y: 77, width: 78, angle: 0 },
  { x: 340, y: 76, width: 86, angle: -12 },
  { x: 340, y: 91, width: 86, angle: 12 },
  { x: 278, y: 118, width: 45, angle: 90 },
  { x: 340, y: 198, width: 80, angle: 0 },
  { x: 536, y: 190, width: 98, angle: -22 },
  { x: 142, y: 308, width: 80, angle: 0 },
  { x: 98, y: 268, width: 235, angle: -24 },
  { x: 96, y: 330, width: 68, angle: 90 },
  { x: 340, y: 300, width: 113, angle: -35 },
  { x: 340, y: 404, width: 86, angle: -18 },
  { x: 534, y: 379, width: 104, angle: -25 },
  { x: 678, y: 362, width: 48, angle: 90 },
  { x: 536, y: 454, width: 106, angle: 0 },
];

const DEMO_RESULT: QueryResult = {
  status: "success",
  runId: "qf_7a3e2c91",
  explanation:
    "Fantasy leads total watch hours, while Mystery shows the strongest completion rate. The query uses the governed Watch → Episode → Anime join path and excludes invalid sessions.",
  sql: `SELECT
  g.genre_name AS genre,
  ROUND(SUM(w.watch_seconds) / 3600.0, 1) AS watch_hours,
  ROUND(
    100.0 * SUM(w.completed_flag) / NULLIF(COUNT(*), 0),
    1
  ) AS completion_rate
FROM fact_watch_session AS w
JOIN dim_episode AS e ON w.episode_id = e.episode_id
JOIN dim_anime AS a ON e.anime_id = a.anime_id
JOIN bridge_anime_genre AS ag ON a.anime_id = ag.anime_id
JOIN dim_genre AS g ON ag.genre_id = g.genre_id
WHERE w.is_valid = 1
GROUP BY g.genre_name
ORDER BY watch_hours DESC
LIMIT 6;`,
  columns: ["genre", "watch_hours", "completion_rate"],
  rows: [
    ["Fantasy", 2148.6, 71.8],
    ["Action", 1924.1, 68.4],
    ["Sci-Fi", 1711.8, 74.2],
    ["Romance", 1453.7, 76.9],
    ["Mystery", 1228.4, 81.3],
    ["Comedy", 1104.2, 65.7],
  ],
  rowCount: 6,
};

const INITIAL_RUNS: RunRecord[] = [
  {
    id: "qf_7a3e2c91",
    domainId: SAMPLE_DOMAIN_ID,
    question: "Compare watch hours and completion rate by genre",
    status: "Passed",
    model: "qwen-plus",
    rows: 6,
    duration: "1.84s",
    time: "2 min ago",
  },
  {
    id: "qf_4ce8b1a2",
    domainId: SAMPLE_DOMAIN_ID,
    question: "Top anime by merchandise GMV this quarter",
    status: "Passed",
    model: "qwen-plus",
    rows: 10,
    duration: "2.12s",
    time: "18 min ago",
  },
  {
    id: "qf_e832bb77",
    domainId: SAMPLE_DOMAIN_ID,
    question: "Show every user email with subscription revenue",
    status: "Blocked",
    model: "qwen-plus",
    rows: 0,
    duration: "0.41s",
    time: "42 min ago",
  },
  {
    id: "qf_729af843",
    domainId: SAMPLE_DOMAIN_ID,
    question: "Monthly active subscribers by plan tier",
    status: "Passed",
    model: "gpt-4.1-mini",
    rows: 24,
    duration: "1.61s",
    time: "1 hr ago",
  },
  {
    id: "qf_c239a101",
    domainId: SAMPLE_DOMAIN_ID,
    question: "Which studios have the highest average rating?",
    status: "Passed",
    model: "qwen-plus",
    rows: 12,
    duration: "1.49s",
    time: "3 hr ago",
  },
];

const TABLES = [
  ["fact_watch_session", "150,000", "Fact", "5 metrics"],
  ["fact_ad_impression", "80,000", "Fact", "2 metrics"],
  ["fact_rating", "40,000", "Fact", "1 metric"],
  ["fact_merch_order_item", "37,500", "Fact", "2 metrics"],
  ["fact_user_follow", "24,000", "Fact", "1 metric"],
  ["dim_user", "8,000", "Dimension", "7 dimensions"],
  ["dim_anime", "240", "Dimension", "9 dimensions"],
];

const EXAMPLE_QUESTIONS = [
  "Compare watch hours and completion rate by genre",
  "Which studios generate the most ad revenue?",
  "Show subscription revenue by plan tier and month",
  "Which anime drive both engagement and merch GMV?",
];

const CHINESE_UI_VALUES: Record<string, string> = {
  "Compare watch hours and completion rate by genre": "按类型比较观看时长和完播率",
  "Which studios generate the most ad revenue?": "哪些工作室带来的广告收入最高？",
  "Show subscription revenue by plan tier and month": "按套餐等级和月份展示订阅收入",
  "Which anime drive both engagement and merch GMV?": "哪些动漫同时带来较高参与度和周边商品 GMV？",
  "Which anime generated the most watch hours?": "哪些动漫贡献的观看时长最高？",
  "Top anime by merchandise GMV this quarter": "本季度周边商品 GMV 最高的动漫",
  "Show every user email with subscription revenue": "展示每位用户的邮箱及订阅收入",
  "Monthly active subscribers by plan tier": "按套餐等级统计月活跃订阅用户",
  "Which studios have the highest average rating?": "哪些工作室的平均评分最高？",
  "Fantasy leads total watch hours, while Mystery shows the strongest completion rate. The query uses the governed Watch → Episode → Anime join path and excludes invalid sessions.":
    "奇幻类的总观看时长最高，悬疑类的完播率最高。查询使用经过治理的“观看会话 → 剧集 → 动漫”关联路径，并排除了无效会话。",
  Studio: "工作室",
  Anime: "动漫",
  Genre: "类型",
  "Anime Genre": "动漫类型关联",
  Episode: "剧集",
  "Watch Session": "观看会话",
  "Ad Impression": "广告曝光",
  User: "用户",
  Rating: "评分",
  Subscription: "订阅",
  "User Follow": "用户关注",
  "Merch Product": "周边商品",
  "Merch Order": "周边订单",
  "Order Item": "订单明细",
  Calendar: "日期",
  Watch: "观看会话",
  "Ad impression": "广告曝光",
  "Merch product": "周边商品",
  "Merch order": "周边订单",
  "Release date": "发布日期",
  Date: "日期",
  "Watch hours": "观看时长",
  "Completion rate": "完播率",
  "Unique viewers": "独立观看用户",
  "Average rating": "平均评分",
  "Subscription revenue": "订阅收入",
  "Active subscribers": "活跃订阅用户",
  "Ad revenue": "广告收入",
  "Ad CTR": "广告点击率",
  "Merch GMV": "周边商品 GMV",
  "Merch units": "周边商品销量",
  "Community follows": "社区关注数",
  "Total valid viewing time, normalized to hours.": "有效观看总时长，统一换算为小时。",
  "Share of valid watch sessions completed.": "有效观看会话中的完播比例。",
  "Distinct viewers with a valid watch session.": "存在有效观看会话的去重用户数。",
  "Average submitted anime rating.": "用户提交的动漫平均评分。",
  "Recognized subscription revenue in USD.": "以美元计价的已确认订阅收入。",
  "Distinct users represented by active subscriptions.": "有效订阅对应的去重用户数。",
  "Revenue attributed to governed ad impressions.": "归因到受治理广告曝光的收入。",
  "Click-through rate across eligible impressions.": "符合条件的广告曝光点击率。",
  "Net merchandise value in USD.": "以美元计价的周边商品净交易额。",
  "Total merchandise units purchased.": "已购买的周边商品总件数。",
  "Distinct user-follow relationships created.": "新增的去重用户关注关系数。",
  "Watch → Anime": "观看会话 → 动漫",
  "Watch → Studio": "观看会话 → 工作室",
  "Watch → Release date": "观看会话 → 发布日期",
  "Order item → Anime": "订单明细 → 动漫",
  "Order item → User": "订单明细 → 用户",
  "Order item → Date": "订单明细 → 日期",
  "Ad → Studio": "广告曝光 → 工作室",
  Safe: "安全",
  Fantasy: "奇幻",
  Action: "动作",
  "Sci-Fi": "科幻",
  Romance: "恋爱",
  Mystery: "悬疑",
  Comedy: "喜剧",
  genre: "类型",
  watch_hours: "观看时长",
  completion_rate: "完播率",
  "just now": "刚刚",
  "2 min ago": "2 分钟前",
  "18 min ago": "18 分钟前",
  "42 min ago": "42 分钟前",
  "1 hr ago": "1 小时前",
  "3 hr ago": "3 小时前",
  saved: "已保存",
};

function localizeUiValue(value: string, language: Language) {
  return language === "zh" ? CHINESE_UI_VALUES[value] ?? value : value;
}

const sleep = (duration: number) =>
  new Promise((resolve) => window.setTimeout(resolve, duration));

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function Icon({ value }: { value: string }) {
  return (
    <span className="icon-glyph" aria-hidden="true">
      {value}
    </span>
  );
}

function normalizeQueryResult(payload: Record<string, unknown>): QueryResult {
  const columns = Array.isArray(payload.columns)
    ? payload.columns.map(String)
    : DEMO_RESULT.columns;
  const rows = Array.isArray(payload.rows)
    ? payload.rows.map((row) =>
        Array.isArray(row)
          ? row.map((cell) =>
              typeof cell === "number" ? cell : String(cell ?? ""),
            )
          : [],
      )
    : DEMO_RESULT.rows;

  return {
    status: String(payload.status ?? "success"),
    runId: String(payload.run_id ?? payload.runId ?? "qf_live"),
    explanation: String(payload.explanation ?? "Query completed successfully."),
    sql: String(payload.sql ?? "-- SQL was not included in the response"),
    columns,
    rows,
    rowCount: Number(payload.row_count ?? payload.rowCount ?? rows.length),
  };
}

export default function Home() {
  const [language, setLanguage] = useState<Language>("en");
  const [activeView, setActiveView] = useState<View>("domains");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [connection, setConnection] =
    useState<ConnectionState>("checking");
  const [query, setQuery] = useState(EXAMPLE_QUESTIONS[0]);
  const [isRunning, setIsRunning] = useState(false);
  const [runStage, setRunStage] = useState(0);
  const [result, setResult] = useState<QueryResult>(DEMO_RESULT);
  const [runs, setRuns] = useState<RunRecord[]>(INITIAL_RUNS);
  const [selectedEntity, setSelectedEntity] = useState("watch_session");
  const [semanticTab, setSemanticTab] = useState<SemanticTab>("graph");
  const [entityFilter, setEntityFilter] = useState("");
  const [toast, setToast] = useState("");
  const [domains, setDomains] = useState<DataDomain[]>(INITIAL_DOMAINS);
  const [activeDomainId, setActiveDomainId] = useState(SAMPLE_DOMAIN_ID);
  const [domainMenuOpen, setDomainMenuOpen] = useState(false);
  const [createDomainOpen, setCreateDomainOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadStep, setUploadStep] = useState(1);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [isProfiling, setIsProfiling] = useState(false);
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const [semanticValidated, setSemanticValidated] = useState(false);
  const [semanticDraft, setSemanticDraft] = useState<SemanticDraft>(
    INITIAL_SEMANTIC_DRAFT,
  );
  const [uploadedSources, setUploadedSources] = useState<UploadedSource[]>([]);
  const [runFilter, setRunFilter] = useState<"All" | "Passed" | "Blocked">(
    "All",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const text = useCallback(
    (english: string, chinese: string) =>
      language === "zh" ? chinese : english,
    [language],
  );

  useEffect(() => {
    const savedLanguage = window.localStorage.getItem("nexusql-language");
    if (savedLanguage === "en" || savedLanguage === "zh") {
      document.documentElement.lang = savedLanguage === "zh" ? "zh-CN" : "en";
      const timer = window.setTimeout(() => setLanguage(savedLanguage), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  function toggleLanguage() {
    const nextLanguage = language === "en" ? "zh" : "en";
    setLanguage(nextLanguage);
    window.localStorage.setItem("nexusql-language", nextLanguage);
    document.documentElement.lang = nextLanguage === "zh" ? "zh-CN" : "en";
  }

  const activeDomain =
    domains.find((domain) => domain.id === activeDomainId) ??
    INITIAL_DOMAINS[0];

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);

    fetch("/api/queryforge/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend unavailable");
        return response.json();
      })
      .then(() => setConnection("live"))
      .catch(() => setConnection("demo"))
      .finally(() => window.clearTimeout(timer));

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    fetch("/api/studio/domains")
      .then((response) => {
        if (!response.ok) throw new Error("Persistence unavailable");
        return response.json() as Promise<{
          domains?: Array<Record<string, unknown>>;
        }>;
      })
      .then((payload) => {
        const persisted = (payload.domains ?? []).map((domain) => ({
          id: String(domain.id),
          name: String(domain.name),
          slug: String(domain.slug),
          description: String(domain.description ?? ""),
          owner: String(domain.owner ?? "Workspace admin"),
          status:
            String(domain.status) === "ready"
              ? ("ready" as const)
              : ("draft" as const),
          isSample: Boolean(domain.is_sample),
          sourceCount: Number(domain.source_count ?? 0),
          runCount: Number(domain.run_count ?? 0),
        }));
        if (persisted.length) {
          setDomains(persisted);
          setActiveDomainId((current) =>
            persisted.some((domain) => domain.id === current)
              ? current
              : persisted[0].id,
          );
        }
      })
      .catch(() => undefined);

    fetch("/api/studio/upload")
      .then((response) => {
        if (!response.ok) throw new Error("Persistence unavailable");
        return response.json() as Promise<{
          sources?: Array<Record<string, unknown>>;
        }>;
      })
      .then((payload) => {
        const persisted = (payload.sources ?? []).map((source) => ({
          id: String(source.id),
          domainId: String(source.domain_id ?? SAMPLE_DOMAIN_ID),
          name: String(source.name),
          type: String(source.source_type ?? "DATA"),
          size: formatBytes(Number(source.size_bytes ?? 0)),
          tables: Number(source.table_count ?? 1),
          rows: "Profiled",
          status: "Ready" as const,
        }));
        if (persisted.length) setUploadedSources(persisted);
      })
      .catch(() => undefined);

    fetch("/api/studio/runs")
      .then((response) => {
        if (!response.ok) throw new Error("Persistence unavailable");
        return response.json() as Promise<{
          runs?: Array<Record<string, unknown>>;
        }>;
      })
      .then((payload) => {
        const persisted = (payload.runs ?? []).map((run) => ({
          id: String(run.id),
          domainId: String(run.domain_id ?? SAMPLE_DOMAIN_ID),
          question: String(run.question),
          status:
            String(run.status) === "Blocked"
              ? ("Blocked" as const)
              : ("Passed" as const),
          model: String(run.model ?? "configured model"),
          rows: Number(run.row_count ?? 0),
          duration: String(run.duration ?? "live"),
          time: "saved",
        }));
        if (persisted.length) {
          setRuns((current) => [
            ...persisted,
            ...current.filter(
              (item) => !persisted.some((saved) => saved.id === item.id),
            ),
          ]);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredEntities = useMemo(
    () =>
      ENTITIES.filter((entity) =>
        `${entity.label} ${entity.table}`
          .toLowerCase()
          .includes(entityFilter.toLowerCase()),
      ),
    [entityFilter],
  );

  const activeEntity =
    ENTITIES.find((entity) => entity.name === selectedEntity) ?? ENTITIES[0];

  const filteredRuns = runs.filter(
    (run) =>
      run.domainId === activeDomain.id &&
      (runFilter === "All" || run.status === runFilter),
  );
  const activeDomainSources = uploadedSources.filter(
    (source) => source.domainId === activeDomain.id,
  );
  const activeDomainRuns = runs.filter(
    (run) => run.domainId === activeDomain.id,
  );

  async function runQuery(nextQuestion?: string) {
    const submitted = (nextQuestion ?? query).trim();
    if (!submitted || isRunning) return;
    if (!activeDomain.isSample) {
      setActiveView("ask");
      setToast(
        activeDomainSources.length
          ? text("Publish an executable connector for this domain before running analysis.", "请先为当前数据域发布可执行连接器，再运行分析。")
          : text("Upload data and publish its semantic contract before running analysis.", "请先上传数据并发布语义契约，再运行分析。"),
      );
      return;
    }

    setQuery(submitted);
    setActiveView("ask");
    setIsRunning(true);
    setRunStage(1);
    await sleep(350);
    setRunStage(2);
    await sleep(420);
    setRunStage(3);

    let nextResult = DEMO_RESULT;
    if (connection === "live") {
      try {
        const response = await fetch("/api/queryforge/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: submitted,
            database:
              "sample_data/anime_streaming/anime_streaming.sqlite",
            semantic_model_path:
              "sample_data/anime_streaming/semantic_model.yml",
            sql_policy_path:
              "sample_data/anime_streaming/sql_policy.yml",
            visualize: true,
            report: true,
            complexity_mode: "auto",
          }),
        });
        if (!response.ok) {
          throw new Error("Live query failed");
        }
        nextResult = normalizeQueryResult(await response.json());
      } catch {
        setConnection("demo");
        setToast(text("Live backend unavailable — continued with demo evidence.", "实时后端不可用，已切换为演示证据。"));
      }
    } else {
      await sleep(460);
    }

    setRunStage(4);
    await sleep(300);
    setResult(nextResult);
    setRuns((current) => [
      {
        id: nextResult.runId,
        domainId: activeDomain.id,
        question: submitted,
        status: "Passed",
        model: connection === "live" ? "configured model" : "demo-model",
        rows: nextResult.rowCount,
        duration: connection === "live" ? "live" : "1.84s",
        time: "just now",
      },
      ...current.filter((item) => item.id !== nextResult.runId),
    ]);
    void fetch("/api/studio/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: nextResult.runId,
        domainId: activeDomain.id,
        question: submitted,
        status: "Passed",
        model: connection === "live" ? "configured model" : "demo-model",
        rowCount: nextResult.rowCount,
        duration: connection === "live" ? "live" : "1.84s",
      }),
    }).catch(() => undefined);
    setIsRunning(false);
    setToast(text("Governed query completed.", "受治理查询已完成。"));
  }

  function submitQuery(event: FormEvent) {
    event.preventDefault();
    void runQuery();
  }

  function copySql() {
    void navigator.clipboard.writeText(result.sql);
    setToast(text("SQL copied to clipboard.", "SQL 已复制到剪贴板。"));
  }

  function downloadResult() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            question: query,
            ...result,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${result.runId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast(text("Run artifact downloaded.", "运行产物已下载。"));
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setUploadFiles(files);
    setSemanticReviewed(false);
    setSemanticValidated(false);
    setSemanticDraft({
      ...INITIAL_SEMANTIC_DRAFT,
      description: `One governed business record represented by data uploaded to ${activeDomain.name}.`,
      owner: activeDomain.owner,
    });
  }

  async function profileFiles() {
    if (!uploadFiles.length) return;
    setIsProfiling(true);
    await sleep(900);
    setIsProfiling(false);
    setUploadStep(2);
  }

  async function validateUploadSemantic() {
    if (!semanticReviewed) return;
    const requiredFields = [
      semanticDraft.entity,
      semanticDraft.description,
      semanticDraft.owner,
      semanticDraft.grain,
      semanticDraft.primaryKey,
    ];
    const metricsValid =
      semanticDraft.metrics.length > 0 &&
      semanticDraft.metrics.every(
        (metric) =>
          metric.name && metric.description && metric.expression,
      );
    if (requiredFields.some((value) => !value.trim()) || !metricsValid) {
      setSemanticValidated(false);
      setToast(text("Complete the entity, grain, owner, and metric contract first.", "请先完善实体、粒度、负责人和指标契约。"));
      return;
    }
    await sleep(500);
    setSemanticValidated(true);
    setToast(text("Semantic contract passed all blocking checks.", "语义契约已通过全部阻断性检查。"));
  }

  async function publishUpload() {
    if (!semanticReviewed || !semanticValidated || !uploadFiles.length) return;
    const totalBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
    const payload = new FormData();
    uploadFiles.forEach((file) => payload.append("files", file));
    payload.append("domain_id", activeDomain.id);
    payload.append("reviewed", "true");
    payload.append(
      "semantic_contract",
      JSON.stringify({
        ...semanticDraft,
        reviewed: true,
        version: 1,
      }),
    );

    let persisted = false;
    try {
      const response = await fetch("/api/studio/upload", {
        method: "POST",
        body: payload,
      });
      persisted = response.ok;
    } catch {
      persisted = false;
    }

    setUploadedSources((current) => [
      {
        id: crypto.randomUUID(),
        domainId: activeDomain.id,
        name:
          uploadFiles.length === 1
            ? uploadFiles[0].name
            : `${uploadFiles[0].name} + ${uploadFiles.length - 1}`,
        type: uploadFiles
          .map((file) => file.name.split(".").pop()?.toUpperCase() ?? "FILE")
          .filter((value, index, list) => list.indexOf(value) === index)
          .join(" · "),
        size: formatBytes(totalBytes),
        tables: uploadFiles.length,
        rows: "Profiled",
        status: "Ready",
      },
      ...current,
    ]);
    setDomains((current) =>
      current.map((domain) =>
        domain.id === activeDomain.id
          ? {
              ...domain,
              sourceCount: domain.sourceCount + 1,
              status: "ready",
            }
          : domain,
      ),
    );
    setUploadOpen(false);
    setUploadStep(1);
    setUploadFiles([]);
    setSemanticReviewed(false);
    setSemanticValidated(false);
    setToast(
      persisted
        ? text("Data and semantic model published atomically.", "数据与语义模型已原子发布。")
        : text("Demo source published locally with its semantic contract.", "演示数据源及其语义契约已在本地发布。"),
    );
  }

  function selectRun(run: RunRecord) {
    setActiveDomainId(run.domainId);
    setQuery(run.question);
    setActiveView("ask");
  }

  function selectDomain(domain: DataDomain, view: View = "overview") {
    setActiveDomainId(domain.id);
    setDomainMenuOpen(false);
    setActiveView(view);
    setQuery(
      domain.isSample
        ? EXAMPLE_QUESTIONS[0]
        : "Ask a governed question about this data domain",
    );
    setToast(`${domain.name} is now the active data domain.`);
  }

  async function createDomain(input: {
    name: string;
    description: string;
    owner: string;
  }) {
    let created: DataDomain = {
      id: `domain_${crypto.randomUUID().replaceAll("-", "")}`,
      name: input.name,
      slug: input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
      description: input.description,
      owner: input.owner || "Workspace admin",
      status: "draft",
      isSample: false,
      sourceCount: 0,
      runCount: 0,
    };
    try {
      const response = await fetch("/api/studio/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (response.ok) {
        const payload = (await response.json()) as { domain: DataDomain };
        created = payload.domain;
      }
    } catch {
      // Keep the complete workflow available in local demo mode.
    }
    setDomains((current) => [...current, created]);
    setActiveDomainId(created.id);
    setCreateDomainOpen(false);
    setActiveView("sources");
    setToast(`${created.name} created. Add its first governed data source.`);
  }

  return (
    <LanguageContext.Provider value={{ language, text }}>
    <div className="studio-shell">
      <aside className={cn("sidebar", mobileMenuOpen && "sidebar-open")}>
        <div className="brand-block">
          <button
            className="brand-mark"
            onClick={() => setActiveView("overview")}
            aria-label={text("NexusQL home", "NexusQL 首页")}
          >
            NQ
          </button>
          <div>
            <div className="brand-name">NexusQL</div>
            <div className="brand-caption">{text("Governed data intelligence", "可治理数据智能工作台")}</div>
          </div>
          <span className="beta-badge">BETA</span>
        </div>

        <div className="sidebar-section-label">{text("Workspace", "工作区")}</div>
        <nav className="primary-nav" aria-label={text("Primary navigation", "主导航")}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={cn("nav-item", activeView === item.id && "active")}
              onClick={() => {
                setActiveView(item.id);
                setMobileMenuOpen(false);
              }}
              aria-current={activeView === item.id ? "page" : undefined}
            >
              <Icon value={item.icon} />
              <span>
                <strong>{item.label[language]}</strong>
                <small>{item.caption[language]}</small>
              </span>
              {item.id === "semantic" && (
                <span className="nav-health" aria-label="healthy" />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="workspace-card">
          <div className="workspace-card-top">
            <span className="workspace-avatar">
              {activeDomain.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0])
                .join("")
                .toUpperCase()}
            </span>
            <div>
              <strong>{activeDomain.name}</strong>
              <span>{activeDomain.isSample ? text("Sample data domain", "示例数据域") : text("Workspace data domain", "工作区数据域")}</span>
            </div>
          </div>
          <div className="workspace-progress-row">
            <span>{text("Semantic coverage", "语义覆盖率")}</span>
            <strong>{activeDomain.isSample ? "100%" : activeDomain.sourceCount ? text("Draft", "草稿") : "0%"}</strong>
          </div>
          <div className="workspace-progress">
            <span
              style={{
                width: activeDomain.isSample
                  ? "100%"
                  : activeDomain.sourceCount
                    ? "42%"
                    : "0%",
              }}
            />
          </div>
        </div>

        <button className="profile-row" onClick={() => setSettingsOpen(true)}>
          <span className="profile-avatar">HC</span>
          <span>
            <strong>{text("Workspace admin", "工作区管理员")}</strong>
            <small>{text("Local-first mode", "本地优先模式")}</small>
          </span>
          <Icon value="···" />
        </button>
      </aside>

      {mobileMenuOpen && (
        <button
          className="mobile-overlay"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <main className="main-frame">
        <header className="topbar">
          <button
            className="mobile-menu-button"
            aria-label={text("Open navigation", "打开导航")}
            onClick={() => setMobileMenuOpen(true)}
          >
            ☰
          </button>
          <div className="breadcrumb">
            <span>{text("Workspace", "工作区")}</span>
            <b>/</b>
            <strong>
              {NAV_ITEMS.find((item) => item.id === activeView)?.label[language]}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className="language-toggle"
              onClick={toggleLanguage}
              aria-label={text("Switch interface to Chinese", "将界面切换为英文")}
              title={text("切换到中文", "Switch to English")}
            >
              <span>{language === "en" ? "中" : "EN"}</span>
              <strong>{language === "en" ? "中文" : "English"}</strong>
            </button>
            <button
              className={cn(
                "connection-chip",
                connection === "live" && "is-live",
              )}
              onClick={() => setSettingsOpen(true)}
            >
              <span className="connection-dot" />
              {connection === "checking"
                ? text("Checking API", "正在检查 API")
                : connection === "live"
                  ? text("Live backend", "后端已连接")
                  : text("Interactive demo", "交互演示模式")}
            </button>
            <button
              className="dataset-switcher"
              onClick={() => setDomainMenuOpen((open) => !open)}
              aria-expanded={domainMenuOpen}
              aria-haspopup="menu"
            >
              <span className="dataset-icon">A</span>
              <span>
                <small>{text("Active data domain", "当前数据域")}</small>
                <strong>{activeDomain.name}</strong>
              </span>
              <span className="chevron">⌄</span>
            </button>
            {domainMenuOpen && (
              <div className="domain-switcher-menu" role="menu">
                <div className="domain-switcher-heading">
                  <span>{text("Switch data domain", "切换数据域")}</span>
                  <button
                    onClick={() => {
                      setDomainMenuOpen(false);
                      setCreateDomainOpen(true);
                    }}
                  >
                    ＋ {text("New", "新建")}
                  </button>
                </div>
                {domains.map((domain) => (
                  <button
                    key={domain.id}
                    className={cn(
                      "domain-switcher-option",
                      domain.id === activeDomain.id && "active",
                    )}
                    onClick={() => selectDomain(domain)}
                    role="menuitem"
                  >
                    <span className="domain-option-icon">
                      {domain.isSample ? "A" : "D"}
                    </span>
                    <span>
                      <strong>{domain.name}</strong>
                      <small>
                        {domain.sourceCount} {text(domain.sourceCount === 1 ? "source" : "sources", "个数据源")} · {domain.status === "ready" ? text("ready", "就绪") : text("draft", "草稿")}
                      </small>
                    </span>
                    {domain.id === activeDomain.id && <em>✓</em>}
                  </button>
                ))}
                <button
                  className="domain-switcher-all"
                  onClick={() => {
                    setDomainMenuOpen(false);
                    setActiveView("domains");
                  }}
                >
                  {text("Manage all data domains →", "管理全部数据域 →")}
                </button>
              </div>
            )}
            <button
              className="icon-button"
              aria-label={text("Open settings", "打开设置")}
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
          </div>
        </header>

        <div className="content-scroll">
          {activeView === "domains" && (
            <DomainsView
              domains={domains}
              activeDomainId={activeDomain.id}
              sourceCounts={uploadedSources.reduce<Record<string, number>>(
                (counts, source) => {
                  counts[source.domainId] = (counts[source.domainId] ?? 0) + 1;
                  return counts;
                },
                {},
              )}
              selectDomain={selectDomain}
              createDomain={() => setCreateDomainOpen(true)}
            />
          )}
          {activeView === "overview" && (
            <OverviewView
              domain={activeDomain}
              query={query}
              setQuery={setQuery}
              runQuery={runQuery}
              openSources={() => setActiveView("sources")}
              openSemantic={() => setActiveView("semantic")}
              openRuns={() => setActiveView("runs")}
              connection={connection}
              runs={activeDomainRuns}
            />
          )}
          {activeView === "sources" && (
            <SourcesView
              domain={activeDomain}
              uploadedSources={activeDomainSources}
              openUpload={() => setUploadOpen(true)}
              openSemantic={() => setActiveView("semantic")}
            />
          )}
          {activeView === "pipelines" && (
            <PipelinesView
              domain={activeDomain}
              hasSources={activeDomain.isSample || activeDomainSources.length > 0}
              openSources={() => setActiveView("sources")}
            />
          )}
          {activeView === "semantic" && (
            <SemanticView
              domain={activeDomain}
              hasSources={activeDomain.isSample || activeDomainSources.length > 0}
              openUpload={() => setUploadOpen(true)}
              tab={semanticTab}
              setTab={setSemanticTab}
              entityFilter={entityFilter}
              setEntityFilter={setEntityFilter}
              filteredEntities={filteredEntities}
              selectedEntity={selectedEntity}
              selectEntity={setSelectedEntity}
              activeEntity={activeEntity}
              toast={setToast}
            />
          )}
          {activeView === "ask" && (
            <AskView
              domain={activeDomain}
              hasSources={activeDomain.isSample || activeDomainSources.length > 0}
              query={query}
              setQuery={setQuery}
              submitQuery={submitQuery}
              runQuery={runQuery}
              isRunning={isRunning}
              runStage={runStage}
              result={result}
              copySql={copySql}
              downloadResult={downloadResult}
              runs={activeDomainRuns.slice(0, 4)}
              selectRun={selectRun}
              connection={connection}
            />
          )}
          {activeView === "runs" && (
            <RunsView
              runs={filteredRuns}
              filter={runFilter}
              setFilter={setRunFilter}
              selectRun={selectRun}
              downloadResult={downloadResult}
            />
          )}
        </div>
      </main>

      {uploadOpen && (
        <UploadModal
          domain={activeDomain}
          step={uploadStep}
          files={uploadFiles}
          isProfiling={isProfiling}
          reviewed={semanticReviewed}
          validated={semanticValidated}
          semanticDraft={semanticDraft}
          setSemanticDraft={setSemanticDraft}
          resetValidation={() => setSemanticValidated(false)}
          fileInputRef={fileInputRef}
          close={() => {
            setUploadOpen(false);
            setUploadStep(1);
          }}
          handleFiles={handleFiles}
          profileFiles={profileFiles}
          setStep={setUploadStep}
          setReviewed={setSemanticReviewed}
          validateSemantic={validateUploadSemantic}
          publishUpload={publishUpload}
        />
      )}

      {createDomainOpen && (
        <CreateDomainModal
          close={() => setCreateDomainOpen(false)}
          createDomain={createDomain}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          connection={connection}
          close={() => setSettingsOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </div>
    </LanguageContext.Provider>
  );
}

function DomainsView({
  domains,
  activeDomainId,
  sourceCounts,
  selectDomain,
  createDomain,
}: {
  domains: DataDomain[];
  activeDomainId: string;
  sourceCounts: Record<string, number>;
  selectDomain: (domain: DataDomain, view?: View) => void;
  createDomain: () => void;
}) {
  const { text } = useLanguage();
  return (
    <div className="page domains-page">
      <PageHeader
        eyebrow={text("GOVERNED CONTEXT", "受治理的业务上下文")}
        title={text("Data Domains", "数据域")}
        description={text("Create isolated business contexts, then add each domain’s sources, semantic definitions, policies, and analytical history.", "创建相互隔离的业务上下文，并分别管理每个数据域的数据源、语义定义、治理策略和分析历史。")}
        action={
          <button className="primary-button" onClick={createDomain}>
            <span>＋</span> {text("New data domain", "新建数据域")}
          </button>
        }
      />

      <section className="domain-hero panel">
        <div>
          <span className="panel-kicker">{text("DOMAIN-FIRST WORKFLOW", "数据域优先工作流")}</span>
          <h2>{text("One platform. Many governed business contexts.", "一个平台，承载多个受治理的业务场景。")}</h2>
          <p>
            {text("Every upload, entity, metric, Join Path, contract, and run belongs to the selected data domain. Context never leaks across domains.", "每次上传、每个实体、指标、Join Path、契约和运行记录都归属于选中的数据域，业务上下文不会跨域泄漏。")}
          </p>
        </div>
        <div className="domain-flow" aria-label={text("Data domain workflow", "数据域工作流")}>
          {[
            ["01", text("Create domain", "创建数据域")],
            ["02", text("Add sources", "添加数据源")],
            ["03", text("Review semantics", "评审语义")],
            ["04", text("Ask with evidence", "基于证据问答")],
          ].map(([index, label], itemIndex) => (
            <span key={label}>
              <i>{index}</i>
              <strong>{label}</strong>
              {itemIndex < 3 && <b>→</b>}
            </span>
          ))}
        </div>
      </section>

      <div className="domain-grid">
        {domains.map((domain) => {
          const sourceCount = Math.max(
            domain.isSample ? 1 : 0,
            domain.sourceCount,
            sourceCounts[domain.id] ?? 0,
          );
          return (
            <article
              className={cn(
                "domain-card",
                domain.id === activeDomainId && "active",
              )}
              key={domain.id}
            >
              <div className="domain-card-top">
                <span className={cn("domain-card-icon", domain.isSample && "sample")}>
                  {domain.isSample ? "A" : "D"}
                </span>
                <div>
                  <div className="domain-card-labels">
                    {domain.id === activeDomainId && (
                      <span className="status-pill success">{text("ACTIVE", "当前")}</span>
                    )}
                    {domain.isSample && (
                      <span className="status-pill neutral">{text("SAMPLE", "示例")}</span>
                    )}
                  </div>
                  <h2>{domain.name}</h2>
                  <code>{domain.slug}</code>
                </div>
              </div>
              <p>{domain.description}</p>
              <div className="domain-card-stats">
                <span>
                  <strong>{sourceCount}</strong>
                  <small>{text("Sources", "数据源")}</small>
                </span>
                <span>
                  <strong>{domain.isSample ? 15 : sourceCount ? 1 : 0}</strong>
                  <small>{text("Entities", "实体")}</small>
                </span>
                <span>
                  <strong>{domain.isSample ? 11 : 0}</strong>
                  <small>{text("Metrics", "指标")}</small>
                </span>
                <span>
                  <strong>{domain.isSample ? "82/82" : sourceCount ? text("Draft", "草稿") : "—"}</strong>
                  <small>{text("Contract", "契约")}</small>
                </span>
              </div>
              <footer>
                <span>
                  {text("Owner", "负责人")} <strong>{domain.owner}</strong>
                </span>
                <button
                  className={
                    domain.id === activeDomainId
                      ? "secondary-button"
                      : "primary-button"
                  }
                  onClick={() => selectDomain(domain)}
                >
                  {domain.id === activeDomainId
                    ? text("Open active domain →", "打开当前数据域 →")
                    : text("Select domain →", "选择数据域 →")}
                </button>
              </footer>
            </article>
          );
        })}

        <button className="domain-create-card" onClick={createDomain}>
          <span>＋</span>
          <strong>{text("Create another data domain", "创建另一个数据域")}</strong>
          <p>{text("Start with a clean semantic and governance boundary.", "从清晰、隔离的语义与治理边界开始。")}</p>
        </button>
      </div>
    </div>
  );
}

function OverviewView({
  domain,
  query,
  setQuery,
  runQuery,
  openSources,
  openSemantic,
  openRuns,
  connection,
  runs,
}: {
  domain: DataDomain;
  query: string;
  setQuery: (value: string) => void;
  runQuery: (value?: string) => Promise<void>;
  openSources: () => void;
  openSemantic: () => void;
  openRuns: () => void;
  connection: ConnectionState;
  runs: RunRecord[];
}) {
  const { text } = useLanguage();
  if (!domain.isSample) {
    return (
      <div className="page page-overview">
        <section className="hero-panel domain-onboarding-hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="pulse-dot" />
              {text("ACTIVE DATA DOMAIN", "当前数据域")}
            </div>
            <h1>
              {domain.name}
              <span>{text("Build its trusted analytical language.", "构建可信的业务分析语言。")}</span>
            </h1>
            <p>
              {text("This domain is isolated from every other business context. Complete the source and semantic contract steps to activate governed analysis.", "此数据域与其他业务上下文完全隔离。完成数据源接入与语义契约，即可启用受治理分析。")}
            </p>
            <div className="onboarding-actions">
              <button className="primary-button" onClick={openSources}>
                {text("Add domain data →", "添加域内数据 →")}
              </button>
              <button className="secondary-button" onClick={openSemantic}>
                {text("Open semantic studio", "打开语义工作台")}
              </button>
            </div>
          </div>
          <div className="domain-readiness">
            <span className="panel-kicker">{text("ACTIVATION PATH", "启用路径")}</span>
            {[
              [text("Data domain created", "数据域已创建"), true],
              [text("Source profiled", "数据源已剖析"), domain.sourceCount > 0],
              [text("Semantic contract reviewed", "语义契约已评审"), false],
              [text("Execution connector ready", "执行连接器已就绪"), false],
            ].map(([label, complete], index) => (
              <div key={String(label)} className={cn(complete && "complete")}>
                <span>{complete ? "✓" : index + 1}</span>
                <strong>{label}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="metric-grid" aria-label={text("Domain metrics", "数据域指标")}>
          <MetricCard
            label={text("Connected sources", "已连接数据源")}
            value={String(domain.sourceCount)}
            detail={text("Scoped to this domain", "仅限当前数据域")}
            trend={domain.sourceCount ? text("Profiled", "已剖析") : text("Action required", "需要处理")}
            icon="▦"
            onClick={openSources}
          />
          <MetricCard
            label={text("Semantic entities", "语义实体")}
            value={domain.sourceCount ? text("1 draft", "1 个草稿") : "0"}
            detail={text("Human review required", "需要人工评审")}
            trend={text("Domain isolated", "数据域已隔离")}
            icon="⌘"
            onClick={openSemantic}
          />
          <MetricCard
            label={text("Business metrics", "业务指标")}
            value="0"
            detail={text("Define after profiling", "剖析后定义")}
            trend={text("No borrowed meaning", "不复用其他域语义")}
            icon="ƒ"
            onClick={openSemantic}
          />
          <MetricCard
            label={text("Contract status", "契约状态")}
            value={text("Draft", "草稿")}
            detail={text("Blocking until published", "发布前禁止执行")}
            trend={text("Safe by default", "默认安全")}
            icon="◇"
            onClick={openSemantic}
          />
        </section>
        <section className="panel domain-empty-panel">
          <span className="domain-card-icon">D</span>
          <div>
            <span className="panel-kicker">{text("NEXT BEST ACTION", "下一步建议")}</span>
            <h2>
              {domain.sourceCount
                ? text("Finish the semantic contract", "完善语义契约")
                : text("Upload the first domain-owned source", "上传首个域内数据源")}
            </h2>
            <p>
              {text("NexusQL will profile physical structure, propose a semantic draft, require an owner review, and publish data plus meaning atomically.", "NexusQL 会剖析物理结构、生成语义草稿、要求负责人评审，并以原子方式同时发布数据与业务语义。")}
            </p>
          </div>
          <button
            className="primary-button"
            onClick={domain.sourceCount ? openSemantic : openSources}
          >
            {text("Continue setup →", "继续配置 →")}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page page-overview">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="pulse-dot" />
            {text("SEMANTIC LAYER ONLINE", "语义层已上线")}
          </div>
          <h1>
            {text("Turn this domain into trusted answers.", "让数据域产出可信答案。")}
            <span>{text("Inspect every decision.", "检查每一次决策。")}</span>
          </h1>
          <p>
            <strong>{domain.name}</strong>{text(" is the selected sample domain. Natural-language analytics stays grounded in its governed metrics, explicit Join Paths, and read-only SQL policy.", " 是当前示例数据域。自然语言分析严格基于受治理指标、明确的 Join Path 和只读 SQL 策略。")}
          </p>
          <form
            className="hero-query"
            onSubmit={(event) => {
              event.preventDefault();
              void runQuery();
            }}
          >
            <span className="query-spark">✦</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={text("Ask a data question", "输入数据问题")}
              placeholder={text("Ask a question about your data…", "用自然语言询问你的数据…")}
            />
            <div className="query-shortcut">
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </div>
            <button type="submit">{text("Run query", "运行查询")}</button>
          </form>
          <div className="hero-suggestions">
            <span>{text("Try:", "试试：")}</span>
            {EXAMPLE_QUESTIONS.slice(1, 4).map((item) => (
              <button key={item} onClick={() => void runQuery(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit-ring ring-one" />
          <div className="orbit-ring ring-two" />
          <div className="orbit-core">
            <span>82</span>
            <small>{text("contracts", "契约")}</small>
          </div>
          <span className="orbit-node node-a">SQL</span>
          <span className="orbit-node node-b">METRIC</span>
          <span className="orbit-node node-c">POLICY</span>
          <span className="orbit-node node-d">QA</span>
        </div>
      </section>

      <section className="metric-grid" aria-label={text("Workspace metrics", "工作区指标")}>
        <MetricCard
          label={text("Queryable records", "可查询记录")}
          value="370,762"
          detail={text("15 governed tables", "15 张受治理表")}
          trend={text("+100% synthetic", "100% 合成数据")}
          icon="▦"
          onClick={openSources}
        />
        <MetricCard
          label={text("Semantic entities", "语义实体")}
          value="15"
          detail={text("30 relationships", "30 条关系")}
          trend={text("7 Join Paths", "7 条 Join Path")}
          icon="⌘"
          onClick={openSemantic}
        />
        <MetricCard
          label={text("Business metrics", "业务指标")}
          value="11"
          detail={text("6 analytical domains", "6 个分析主题")}
          trend={text("100% owned", "100% 有负责人")}
          icon="ƒ"
          onClick={openSemantic}
        />
        <MetricCard
          label={text("Contract health", "契约健康度")}
          value="82/82"
          detail={text("0 blocking failures", "0 个阻断项")}
          trend={text("No drift", "无漂移")}
          icon="✓"
          onClick={openSemantic}
        />
      </section>

      <section className="overview-grid">
        <div className="panel engagement-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{text("ENGAGEMENT", "用户参与度")}</span>
              <h2>{text("Watch hours by genre", "各类型观看时长")}</h2>
            </div>
            <div className="segmented small">
              <button className="active">30D</button>
              <button>90D</button>
              <button>1Y</button>
            </div>
          </div>
          <div className="chart-summary">
            <strong>9,570.8</strong>
            <span>{text("governed watch hours", "受治理观看时长")}</span>
            <em>↗ 12.4%</em>
          </div>
          <div className="area-chart" aria-label="Watch hours trend">
            <div className="chart-grid-line line-25" />
            <div className="chart-grid-line line-50" />
            <div className="chart-grid-line line-75" />
            {[42, 48, 45, 59, 54, 69, 63, 76, 72, 85, 81, 94].map(
              (height, index) => (
                <span
                  key={index}
                  className="area-bar"
                  style={{ height: `${height}%` }}
                />
              ),
            )}
          </div>
          <div className="chart-axis">
            <span>Jun 24</span>
            <span>Jul 01</span>
            <span>Jul 08</span>
            <span>Jul 15</span>
            <span>Jul 22</span>
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-primary" /> {text("Watch hours", "观看时长")}
            </span>
            <span>
              <i className="legend-secondary" /> {text("Completion rate", "完播率")}
            </span>
          </div>
        </div>

        <div className="panel contract-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{text("GOVERNANCE", "数据治理")}</span>
              <h2>{text("Semantic contract", "语义契约")}</h2>
            </div>
            <button className="text-button" onClick={openSemantic}>
              {text("Open studio →", "打开工作台 →")}
            </button>
          </div>
          <div className="contract-score">
            <div className="score-ring">
              <span>100</span>
              <small>{text("score", "评分")}</small>
            </div>
            <div>
              <strong>{text("Production ready", "生产就绪")}</strong>
              <p>{text("All blocking semantic and physical checks passed.", "所有阻断性语义与物理检查均已通过。")}</p>
            </div>
          </div>
          <div className="contract-checks">
            {[
              [text("Metric definitions", "指标定义"), "11 / 11"],
              [text("Relationship integrity", "关系完整性"), "30 / 30"],
              [text("Governed Join Paths", "受治理 Join Path"), "7 / 7"],
              [text("Quality & ownership", "质量与负责人"), "34 / 34"],
            ].map(([label, value]) => (
              <div key={label}>
                <span className="check-mark">✓</span>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="contract-footer">
            <span>{text("Last validated 4 minutes ago", "4 分钟前完成验证")}</span>
            <span className="status-pill success">{text("NO DRIFT", "无漂移")}</span>
          </div>
        </div>
      </section>

      <section className="overview-grid lower">
        <div className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{text("RECENT ACTIVITY", "最近活动")}</span>
              <h2>{text("Governed runs", "受治理运行")}</h2>
            </div>
            <button className="text-button" onClick={openRuns}>
              {text("View all →", "查看全部 →")}
            </button>
          </div>
          <div className="activity-list">
            {runs.slice(0, 4).map((run) => (
              <button
                key={run.id}
                className="activity-row"
                onClick={() => void runQuery(run.question)}
              >
                <span
                  className={cn(
                    "activity-icon",
                    run.status === "Blocked" && "blocked",
                  )}
                >
                  {run.status === "Blocked" ? "!" : "✓"}
                </span>
                <span className="activity-question">
                  <strong>{run.question}</strong>
                  <small>
                    {run.id} · {run.model}
                  </small>
                </span>
                <span className="activity-meta">
                  <strong>{run.duration}</strong>
                  <small>{run.time}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel platform-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{text("RUNTIME", "运行环境")}</span>
              <h2>{text("Platform health", "平台健康状态")}</h2>
            </div>
            <span
              className={cn(
                "status-pill",
                connection === "live" ? "success" : "neutral",
              )}
            >
              {connection === "live" ? text("LIVE", "在线") : text("DEMO", "演示")}
            </span>
          </div>
          <div className="runtime-stack">
            {[
              [text("Semantic layer", "语义层"), text("Healthy", "健康"), text("82 checks", "82 项检查")],
              [text("SQL policy", "SQL 策略"), text("Enforced", "已执行"), text("Read-only", "只读")],
              [text("Data freshness", "数据新鲜度"), text("Current", "当前"), text("4 min ago", "4 分钟前")],
              [text("Model gateway", "模型网关"), connection === "live" ? text("Connected", "已连接") : text("Demo", "演示"), text("Auto", "自动")],
            ].map(([label, value, detail]) => (
              <div className="runtime-row" key={label}>
                <span className="runtime-symbol">◆</span>
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  trend,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  trend: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button className="metric-card" onClick={onClick}>
      <span className="metric-icon">
        <Icon value={icon} />
      </span>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
      <span className="metric-trend">{trend}</span>
    </button>
  );
}

function SourcesView({
  domain,
  uploadedSources,
  openUpload,
  openSemantic,
}: {
  domain: DataDomain;
  uploadedSources: UploadedSource[];
  openUpload: () => void;
  openSemantic: () => void;
}) {
  const { text } = useLanguage();
  return (
    <div className="page">
      <PageHeader
        eyebrow={text("DATA FOUNDATION", "数据基础")}
        title={`${domain.name} · ${text("Data Sources", "数据源")}`}
        description={text("Sources are isolated inside the active data domain and can publish only with a reviewed semantic contract.", "数据源在当前数据域内隔离，只有通过人工评审的语义契约才能发布。")}
        action={
          <button className="primary-button" onClick={openUpload}>
            <span>＋</span> {text("Add data source", "添加数据源")}
          </button>
        }
      />

      <div className={cn("source-summary-grid", !domain.isSample && "single")}>
        {domain.isSample && (
          <div className="source-feature-card">
          <div className="source-card-header">
            <span className="source-logo sqlite">SQL</span>
            <div>
              <span className="status-pill success">{text("ACTIVE", "当前")}</span>
              <h3>Anime Streaming</h3>
              <p>{text("SQLite · synthetic product analytics", "SQLite · 合成产品分析数据")}</p>
            </div>
            <button className="icon-button" aria-label="Source actions">
              ···
            </button>
          </div>
          <div className="source-stats">
            <div>
              <span>{text("Tables", "数据表")}</span>
              <strong>15</strong>
            </div>
            <div>
              <span>{text("Rows", "行数")}</span>
              <strong>370,762</strong>
            </div>
            <div>
              <span>{text("Size", "大小")}</span>
              <strong>33.4 MB</strong>
            </div>
            <div>
              <span>{text("Last profile", "最近剖析")}</span>
              <strong>{text("4m ago", "4 分钟前")}</strong>
            </div>
          </div>
          <div className="source-contract-row">
            <span className="check-mark">✓</span>
            <span>
              <strong>{text("Semantic model published", "语义模型已发布")}</strong>
              <small>{text("15 entities · 11 metrics · 82/82 checks", "15 个实体 · 11 个指标 · 82/82 项检查")}</small>
            </span>
            <button onClick={openSemantic}>{text("Inspect →", "检查 →")}</button>
          </div>
          </div>
        )}

        <button className="add-source-card" onClick={openUpload}>
          <span className="add-source-icon">＋</span>
          <strong>
            {domain.isSample ? text("Connect another source", "连接其他数据源") : text("Add the first domain source", "添加首个域内数据源")}
          </strong>
          <p>SQLite、CSV {text("or", "或")} Parquet</p>
          <span className="tiny-label">{text("SEMANTICS REQUIRED", "必须评审语义")}</span>
        </button>
      </div>

      {!domain.isSample && uploadedSources.length === 0 && (
        <section className="panel domain-source-empty">
          <span className="domain-card-icon">D</span>
          <div>
            <span className="panel-kicker">{text("EMPTY DOMAIN", "空数据域")}</span>
            <h2>{text(`No data has entered ${domain.name}`, `${domain.name} 尚未接入数据`)}</h2>
            <p>
              {text("Upload files here to profile them inside this domain. NexusQL will not borrow entities or metrics from the Anime Streaming sample.", "在此上传文件并在当前数据域内完成剖析。NexusQL 不会借用 Anime Streaming 示例中的实体或指标。")}
            </p>
          </div>
          <button className="primary-button" onClick={openUpload}>
            {text("Upload domain data →", "上传域内数据 →")}
          </button>
        </section>
      )}

      {uploadedSources.length > 0 && (
        <section className="panel uploaded-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{text("NEWLY PUBLISHED", "最近发布")}</span>
              <h2>{text("Your uploaded sources", "已上传的数据源")}</h2>
            </div>
          </div>
          <div className="uploaded-source-grid">
            {uploadedSources.map((source) => (
              <div className="uploaded-source-card" key={source.id}>
                <span className="source-logo file">↑</span>
                <div>
                  <strong>{source.name}</strong>
                  <span>
                    {source.type} · {source.size}
                  </span>
                </div>
                <span className="status-pill success">{source.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className={cn("sources-layout", !domain.isSample && "domain-only")}>
        {domain.isSample && (
        <section className="panel table-inventory">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">PHYSICAL MODEL</span>
              <h2>Table inventory</h2>
            </div>
            <div className="table-search">
              <span>⌕</span>
              <input placeholder="Filter tables…" aria-label="Filter tables" />
            </div>
          </div>
          <div className="data-table">
            <div className="data-table-head four">
              <span>Table</span>
              <span>Rows</span>
              <span>Role</span>
              <span>Semantic coverage</span>
            </div>
            {TABLES.map(([table, rows, role, coverage]) => (
              <div className="data-table-row four" key={table}>
                <span className="table-name">
                  <i>{role === "Fact" ? "F" : "D"}</i>
                  <strong>{table}</strong>
                </span>
                <span className="mono">{rows}</span>
                <span>
                  <span
                    className={cn(
                      "type-pill",
                      role === "Fact" ? "fact" : "dimension",
                    )}
                  >
                    {role}
                  </span>
                </span>
                <span className="coverage-cell">
                  <i>
                    <b style={{ width: "100%" }} />
                  </i>
                  {coverage}
                </span>
              </div>
            ))}
            <button className="table-more">Show all 15 tables</button>
          </div>
        </section>
        )}

        <aside className="panel pipeline-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">PUBLICATION PIPELINE</span>
              <h2>Atomic by design</h2>
            </div>
          </div>
          <div className="pipeline-steps">
            {[
              ["01", "Upload", "Bytes accepted and fingerprinted"],
              ["02", "Profile", "Schema, grain and quality inferred"],
              ["03", "Review semantics", "Owner confirms business meaning"],
              ["04", "Validate", "Blocking contracts enforced"],
              ["05", "Publish", "Data + semantics commit together"],
            ].map(([index, label, detail], itemIndex) => (
              <div className="pipeline-step" key={label}>
                <span>{index}</span>
                <div>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </div>
                {itemIndex < 4 && <i />}
              </div>
            ))}
          </div>
          <div className="pipeline-note">
            <span>!</span>
            <p>
              If any semantic or quality check fails, no data is published and
              no watermark advances.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PipelinesView({
  domain,
  hasSources,
  openSources,
}: {
  domain: DataDomain;
  hasSources: boolean;
  openSources: () => void;
}) {
  const { text } = useLanguage();
  const [isChecking, setIsChecking] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [pipelineError, setPipelineError] = useState("");

  useEffect(() => {
    if (!domain.isSample) {
      return;
    }
    const controller = new AbortController();
    fetch("/api/queryforge/engineering/pipeline/status", {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Pipeline status unavailable");
        return response.json() as Promise<PipelineStatus>;
      })
      .then((payload) => {
        setPipeline(payload);
        setPipelineError("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPipelineError(
          text(
            "The pipeline API is unavailable. Restart the local backend.",
            "数据管道 API 暂不可用，请重启本地后端。",
          ),
        );
      });
    return () => controller.abort();
  }, [domain.id, domain.isSample, text]);

  async function runPipelineCheck(scenario: "standard" | "quality_failure" = "standard") {
    if (isChecking || !hasSources || !domain.isSample) return;
    setIsChecking(true);
    setPipelineError("");
    try {
      const response = await fetch(`/api/queryforge/engineering/pipeline/run?scenario=${scenario}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Pipeline run failed");
      const payload = (await response.json()) as {
        status: string;
        pipeline: PipelineStatus;
      };
      setPipeline(payload.pipeline);
      if (payload.status !== "success") {
        setPipelineError(text("Pipeline quality gates blocked publication.", "管道质量门禁阻止了发布。"));
      }
    } catch {
      setPipelineError(text("Pipeline execution failed. Inspect the backend log for details.", "管道执行失败，请检查后端日志。"));
    } finally {
      setIsChecking(false);
    }
  }

  const quality = pipeline?.quality;
  const lastRun = pipeline?.last_run;
  const canRun = domain.isSample && hasSources;
  const watermark = pipeline?.watermark?.value ?? text("Not initialized", "尚未初始化");

  return (
    <div className="page pipelines-page">
      <PageHeader
        eyebrow={text("DATA ENGINEERING", "数据工程")}
        title={`${domain.name} · ${text("Data Pipelines", "数据管道")}`}
        description={text(
          "Observe ingestion, validation, transformation, and publication as one governed pipeline with explicit SLAs and lineage.",
          "将接入、校验、转换和发布作为一条受治理的数据管道进行观测，并明确展示 SLA 与数据血缘。",
        )}
        action={
          <div className="pipeline-actions">
            <button
              className="secondary-button pipeline-failure-button"
              onClick={() => void runPipelineCheck("quality_failure")}
              disabled={!canRun || isChecking}
            >
              {text("⚠ Simulate quality failure", "⚠ 模拟质量失败")}
            </button>
            <button
              className="primary-button"
              onClick={() => void runPipelineCheck("standard")}
              disabled={!canRun || isChecking}
            >
              {isChecking
                ? text("Running checks…", "正在执行检查…")
                : text("▶ Run pipeline checks", "▶ 运行管道检查")}
            </button>
          </div>
        }
      />

      {pipelineError && (
        <div className="pipeline-error-banner" role="alert">
          <span>!</span>
          <strong>{pipelineError}</strong>
        </div>
      )}

      {!canRun ? (
        <section className="panel pipeline-empty-state">
          <span className="pipeline-empty-icon">⇢</span>
          <div>
            <span className="panel-kicker">{text("PIPELINE CONFIGURATION REQUIRED", "需要配置数据管道")}</span>
            <h2>{text("Connect data and publish its pipeline contract", "接入数据并发布管道契约")}</h2>
            <p>{text("A runnable pipeline is always scoped to the active data domain. The bundled executable pipeline is available in the Anime Streaming sample domain.", "可执行管道始终限定在当前数据域内。Anime Streaming 示例域已经配置了内置的真实管道。")}</p>
          </div>
          <button className="primary-button" onClick={openSources}>
            {text("Add data source →", "添加数据源 →")}
          </button>
        </section>
      ) : (
        <>
          <section className="pipeline-health-grid" aria-label={text("Pipeline health", "管道健康状态")}>
            {[
              [text("Freshness SLA", "新鲜度 SLA"), pipeline?.watermark ? "Current" : "Pending", pipeline?.watermark ? text("Watermark persisted", "水位线已持久化") : text("Run required", "需要首次运行"), pipeline?.watermark ? "success" : "neutral"],
              [text("Quality gate", "质量门禁"), quality?.checks_total ? `${quality.checks_passed} / ${quality.checks_total}` : "—", quality?.passed ? text("All checks passed", "全部通过") : text("Awaiting evidence", "等待运行证据"), quality?.passed ? "success" : "neutral"],
              [text("Lineage coverage", "血缘覆盖率"), pipeline ? "100%" : "—", pipeline ? text("Source → staging → target", "源 → 暂存 → 目标") : text("Awaiting evidence", "等待运行证据"), pipeline ? "success" : "neutral"],
              [text("Incremental watermark", "增量水位线"), watermark, lastRun?.published_rows === 0 ? text("Idempotent no-op", "幂等空运行") : text("Incremental append", "增量追加"), "neutral"],
            ].map(([label, value, detail, status]) => (
              <article className="pipeline-health-card" key={label}>
                <span className={`pipeline-health-dot ${status}`} />
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </article>
            ))}
          </section>

          <section className="pipeline-workspace-grid">
            <div className="panel pipeline-dag-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">{text("PIPELINE DAG", "管道 DAG")}</span>
                  <h2>{text("Governed asset publication", "受治理数据资产发布")}</h2>
                </div>
                <span className={cn("status-pill", quality?.passed ? "success" : "neutral")}>{isChecking ? text("RUNNING", "运行中") : quality?.passed ? text("HEALTHY", "健康") : text("READY", "就绪")}</span>
              </div>
              <div className={cn("pipeline-dag", isChecking && "is-running")}>
                {[
                  ["01", text("Extract", "抽取"), pipeline?.lineage.source ?? text("CSV source", "CSV 数据源"), String(lastRun?.input_rows ?? pipeline?.source_rows ?? 0)],
                  ["02", text("Validate", "校验"), text("Schema + quality", "结构与质量"), quality?.checks_total ? `${quality.checks_passed}/${quality.checks_total}` : "—"],
                  ["03", text("Transform", "转换"), pipeline?.lineage.staging ?? text("Staging table", "暂存表"), String(lastRun?.staged_rows ?? 0)],
                  ["04", text("Publish", "发布"), pipeline?.lineage.target ?? text("Target table", "目标表"), String(lastRun?.published_rows ?? 0)],
                ].map(([index, label, detail, value], itemIndex) => (
                  <div className="pipeline-dag-stage" key={index}>
                    <span>{index}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </div>
                    <b>{value}</b>
                    {itemIndex < 3 && <i>→</i>}
                  </div>
                ))}
              </div>
              <div className="pipeline-dag-footer">
                <span>{text("Idempotent build", "幂等构建")}</span>
                <span>{text("Atomic publish", "原子发布")}</span>
                <span>{text("Rollback safe", "支持安全回滚")}</span>
                <span>{text("Read-only serving", "只读服务")}</span>
              </div>
            </div>

            <aside className="panel pipeline-observability-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">{text("OBSERVABILITY", "可观测性")}</span>
                  <h2>{text("Latest execution", "最近一次执行")}</h2>
                </div>
              </div>
              <div className="pipeline-run-score">
                <strong>{pipeline?.completed_runs ?? 0}</strong>
                <span>{text("successful runs", "次成功运行")}</span>
              </div>
              <dl className="pipeline-run-facts">
                <div><dt>{text("Rows read", "读取行数")}</dt><dd>{lastRun?.input_rows ?? pipeline?.source_rows ?? 0}</dd></div>
                <div><dt>{text("Rows staged", "暂存行数")}</dt><dd>{lastRun?.staged_rows ?? 0}</dd></div>
                <div><dt>{text("Rows published", "发布行数")}</dt><dd>{lastRun?.published_rows ?? 0}</dd></div>
                <div><dt>{text("Rows quarantined", "隔离行数")}</dt><dd>{lastRun?.quarantined_rows ?? 0}</dd></div>
              </dl>
              <div className="pipeline-sla-bar"><span style={{ width: quality?.passed ? "100%" : "18%" }} /></div>
              <small>{quality?.passed ? text("All persisted quality gates passed", "全部持久化质量门禁已通过") : text("Run the pipeline to collect quality evidence", "运行管道以采集质量证据")}</small>
            </aside>
          </section>
          {quality && quality.failures.length > 0 && (
            <section className="panel pipeline-failures-panel">
              <span className="panel-kicker">{text("QUALITY FAILURES", "质量失败明细")}</span>
              <h2>{text("Publication was blocked", "发布已被阻断")}</h2>
              {quality.failures.map((failure) => <code key={failure}>{failure}</code>)}
              {lastRun?.quarantine.map((item) => (
                <div className="pipeline-quarantine-record" key={`${lastRun.run_id}-${item.reason}`}>
                  <strong>{item.reason}</strong>
                  <pre>{JSON.stringify(item.record, null, 2)}</pre>
                </div>
              ))}
            </section>
          )}
          {pipeline && pipeline.recent_runs.length > 0 && (
            <section className="panel pipeline-history-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">{text("RUN HISTORY", "运行历史")}</span>
                  <h2>{text("Immutable pipeline evidence", "不可变管道证据")}</h2>
                </div>
                <span className="status-pill neutral">
                  {pipeline.completed_runs} {text("passed", "成功")} · {pipeline.failed_runs} {text("failed", "失败")}
                </span>
              </div>
              <div className="pipeline-history-list">
                {pipeline.recent_runs.map((run) => (
                  <article key={run.run_id}>
                    <span className={cn("pipeline-run-state", run.status === "success" ? "success" : "failed")}>
                      {run.status === "success" ? text("PASSED", "通过") : text("BLOCKED", "阻断")}
                    </span>
                    <div>
                      <strong>{run.run_id.slice(0, 18)}…</strong>
                      <small>{new Date(run.created_at).toLocaleString()}</small>
                    </div>
                    <dl>
                      <div><dt>{text("staged", "暂存")}</dt><dd>{run.staged_rows}</dd></div>
                      <div><dt>{text("published", "发布")}</dt><dd>{run.published_rows}</dd></div>
                      <div><dt>{text("quarantined", "隔离")}</dt><dd>{run.quarantined_rows}</dd></div>
                    </dl>
                    <code>{run.watermark_before ?? "∅"} → {run.watermark_after ?? "∅"}</code>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SemanticView({
  domain,
  hasSources,
  openUpload,
  tab,
  setTab,
  entityFilter,
  setEntityFilter,
  filteredEntities,
  selectedEntity,
  selectEntity,
  activeEntity,
  toast,
}: {
  domain: DataDomain;
  hasSources: boolean;
  openUpload: () => void;
  tab: SemanticTab;
  setTab: (tab: SemanticTab) => void;
  entityFilter: string;
  setEntityFilter: (value: string) => void;
  filteredEntities: Entity[];
  selectedEntity: string;
  selectEntity: (name: string) => void;
  activeEntity: Entity;
  toast: (message: string) => void;
}) {
  const { language, text } = useLanguage();
  if (!domain.isSample) {
    return (
      <div className="page semantic-page">
        <PageHeader
          eyebrow={text("DOMAIN SEMANTICS", "数据域语义")}
          title={`${domain.name} · ${text("Semantic Studio", "语义工作台")}`}
          description={text("Build a domain-owned business contract. NexusQL never imports entities, metrics, or Join Paths from another domain.", "构建归属于当前数据域的业务契约。NexusQL 不会从其他数据域导入实体、指标或 Join Path。")}
          action={
            <div className="header-action-group">
              <button className="secondary-button" onClick={openUpload}>
                ＋ {text("Add source", "添加数据源")}
              </button>
              <button
                className="primary-button"
                disabled={!hasSources}
                onClick={() =>
                  toast(
                    hasSources
                      ? "Semantic draft saved for validation."
                      : "Add a source before defining its semantic contract.",
                  )
                }
              >
                {text("Validate draft", "验证草稿")}
              </button>
            </div>
          }
        />

        <div className="semantic-health-strip draft">
          <div className="health-score-mini">
            <strong>{hasSources ? "42" : "0"}</strong>
            <span>/100</span>
          </div>
          <div>
            <strong>
              {hasSources
                ? text("Domain contract needs business review", "数据域契约需要业务评审")
                : text("Semantic construction starts with domain data", "语义构建从域内数据开始")}
            </strong>
            <p>
              {text("Identity, grain, metrics, relationships, ownership, policy, and quality checks must all pass before analysis unlocks.", "实体身份、粒度、指标、关系、负责人、策略和质量检查必须全部通过，才能启用分析。")}
            </p>
          </div>
          <div className="semantic-health-metrics">
            <span>
              <strong>{hasSources ? 1 : 0}</strong> {text("draft entities", "个实体草稿")}
            </span>
            <span>
              <strong>0</strong> {text("relationships", "条关系")}
            </span>
            <span>
              <strong>0</strong> {text("metrics", "个指标")}
            </span>
            <span>
              <strong>0</strong> Join Paths
            </span>
          </div>
          <span className="status-pill neutral">{text("DRAFT", "草稿")}</span>
        </div>

        {!hasSources ? (
          <section className="panel semantic-empty-state">
            <span className="semantic-empty-icon">⌘</span>
            <div>
              <span className="panel-kicker">{text("NO PHYSICAL MODEL YET", "尚无物理模型")}</span>
              <h2>{text("Add data before declaring business meaning", "先接入数据，再声明业务含义")}</h2>
              <p>
                {text("NexusQL profiles tables and columns first, then proposes candidate entities without pretending technical schema names are business definitions.", "NexusQL 会先剖析表和字段，再提出候选实体，不会把技术字段名直接当成业务定义。")}
              </p>
            </div>
            <button className="primary-button" onClick={openUpload}>
              {text("Add governed source →", "添加受治理数据源 →")}
            </button>
          </section>
        ) : (
          <div className="semantic-builder">
            <aside className="semantic-builder-steps">
              <span className="panel-kicker">{text("CONTRACT BUILDER", "契约构建器")}</span>
              {[
                ["01", text("Identity & grain", "实体与粒度"), "active"],
                ["02", text("Dimensions & measures", "维度与度量"), ""],
                ["03", text("Metrics", "指标"), ""],
                ["04", text("Relationships", "关系"), ""],
                ["05", text("Policy & quality", "策略与质量"), ""],
                ["06", text("Review & publish", "评审与发布"), ""],
              ].map(([index, label, state]) => (
                <button className={state} key={label}>
                  <span>{index}</span>
                  <strong>{label}</strong>
                </button>
              ))}
            </aside>
            <section className="panel semantic-contract-editor">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">{text("STEP 01", "第 01 步")}</span>
                  <h2>{text("Define business identity and grain", "定义业务实体与数据粒度")}</h2>
                </div>
                <span className="status-pill neutral">{text("REVIEW REQUIRED", "需要评审")}</span>
              </div>
              <p className="contract-editor-intro">
                {text(
                  "Start from the physical profile, then name the real business entity and state exactly what one row represents.",
                  "从物理数据剖析出发，定义真实的业务实体，并明确说明每一行数据代表什么。",
                )}
              </p>
              <div className="semantic-contract-fields">
                <label>
                  <span>{text("Business entity", "业务实体")}</span>
                  <input defaultValue="uploaded_record" />
                  <small>{text("Use a stable singular business concept.", "使用稳定、单数形式的业务概念。")}</small>
                </label>
                <label>
                  <span>{text("Primary source", "主要数据源")}</span>
                  <input value={text("Latest profiled upload", "最近剖析的上传数据")} readOnly />
                  <small>{text(`Scoped to ${domain.name}.`, `仅归属于 ${domain.name}。`)}</small>
                </label>
                <label className="wide">
                  <span>{text("Business description", "业务说明")}</span>
                  <textarea
                    rows={3}
                    defaultValue={text(
                      "One reviewed business record represented by the uploaded source.",
                      "上传数据源中的一条记录代表一条经过评审的业务记录。",
                    )}
                  />
                </label>
                <label>
                  <span>{text("Grain", "数据粒度")}</span>
                  <input defaultValue="record_id" />
                  <small>{text("Required for safe aggregation.", "安全聚合必须明确数据粒度。")}</small>
                </label>
                <label>
                  <span>{text("Owner", "负责人")}</span>
                  <input defaultValue={domain.owner} />
                  <small>{text("Accountable for semantic approval.", "负责语义审核与批准。")}</small>
                </label>
              </div>
              <div className="contract-guardrail">
                <span>!</span>
                <p>
                  {text(
                    "Analysis remains blocked until the primary key is unique, every metric declares an aggregation and denominator, and all multi-hop relationships have a reviewed Join Path.",
                    "在主键唯一、每个指标明确聚合方式与分母、所有多跳关系都拥有经过评审的 Join Path 之前，分析功能将保持阻断。",
                  )}
                </p>
              </div>
              <footer>
                <span>{text("Autosaved as a domain-local draft", "已自动保存为当前数据域草稿")}</span>
                <button
                  className="primary-button"
                  onClick={() => toast(text("Identity and grain saved.", "实体与粒度已保存。"))}
                >
                  {text("Save & continue →", "保存并继续 →")}
                </button>
              </footer>
            </section>
            <aside className="panel semantic-checklist">
              <span className="panel-kicker">{text("PUBLICATION GATE", "发布门禁")}</span>
              <h3>{text("Required contract", "必需契约")}</h3>
              {[
                [text("Entity has a clear grain", "实体粒度清晰"), true],
                [text("Primary key is unique", "主键唯一"), false],
                [text("Metric units are explicit", "指标单位明确"), false],
                [text("Cardinality is reviewed", "关系基数已评审"), false],
                [text("Sensitive fields are classified", "敏感字段已分类"), false],
                [text("Quality checks pass", "质量检查通过"), false],
              ].map(([label, passed]) => (
                <div key={String(label)} className={cn(passed && "passed")}>
                  <span>{passed ? "✓" : "○"}</span>
                  <strong>{label}</strong>
                </div>
              ))}
              <p>{text("Data and semantics publish atomically only after 100%.", "只有全部门禁通过后，数据与语义才会原子发布。")}</p>
            </aside>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page semantic-page">
      <PageHeader
        eyebrow={text("BUSINESS MEANING", "业务语义")}
        title={`${domain.name} · ${text("Semantic Studio", "语义工作台")}`}
        description={text("Model entities, metrics, relationships, and safe Join Paths before any analytical query can run.", "在执行分析查询之前，先建模实体、指标、关系和安全的 Join Path。")}
        action={
          <div className="header-action-group">
            <button
              className="secondary-button"
              onClick={() => toast(text("Semantic model YAML downloaded.", "语义模型 YAML 已下载。"))}
            >
              ↓ {text("Export YAML", "导出 YAML")}
            </button>
            <button
              className="primary-button success-button"
              onClick={() => toast(text("Semantic model is already published.", "语义模型已经发布。"))}
            >
              ✓ {text("Published", "已发布")}
            </button>
          </div>
        }
      />

      <div className="semantic-health-strip">
        <div className="health-score-mini">
          <strong>82</strong>
          <span>/82</span>
        </div>
        <div>
          <strong>{text("Semantic contract healthy", "语义契约健康")}</strong>
          <p>
            {text("All metric, grain, relationship, ownership, sensitivity, and physical checks pass.", "指标、粒度、关系、负责人、敏感性和物理结构检查均已通过。")}
          </p>
        </div>
        <div className="semantic-health-metrics">
          <span>
            <strong>15</strong> {text("entities", "个实体")}
          </span>
          <span>
            <strong>30</strong> {text("relationships", "条关系")}
          </span>
          <span>
            <strong>11</strong> {text("metrics", "个指标")}
          </span>
          <span>
            <strong>7</strong> Join Paths
          </span>
        </div>
        <span className="status-pill success">{text("NO DRIFT", "无漂移")}</span>
      </div>

      <div className="semantic-tabs">
        <button
          className={cn(tab === "graph" && "active")}
          onClick={() => setTab("graph")}
        >
          {text("Relationship graph", "关系图谱")}
        </button>
        <button
          className={cn(tab === "metrics" && "active")}
          onClick={() => setTab("metrics")}
        >
          {text("Metric catalog", "指标目录")} <span>11</span>
        </button>
        <button
          className={cn(tab === "paths" && "active")}
          onClick={() => setTab("paths")}
        >
          {text("Governed Join Paths", "受治理的 Join Path")} <span>7</span>
        </button>
      </div>

      {tab === "graph" && (
        <div className="semantic-workbench">
          <aside className="entity-browser">
            <div className="workbench-header">
              <div>
                <span className="panel-kicker">{text("ENTITIES", "实体")}</span>
                <strong>{text("Business model", "业务模型")}</strong>
              </div>
              <button aria-label={text("Add entity", "添加实体")}>＋</button>
            </div>
            <label className="entity-search">
              <span>⌕</span>
              <input
                value={entityFilter}
                onChange={(event) => setEntityFilter(event.target.value)}
                placeholder={text("Find an entity…", "查找实体…")}
              />
            </label>
            <div className="entity-list">
              {filteredEntities.map((entity) => (
                <button
                  key={entity.name}
                  className={cn(
                    "entity-list-item",
                    entity.name === selectedEntity && "active",
                  )}
                  onClick={() => selectEntity(entity.name)}
                >
                  <span className={cn("entity-type-dot", entity.kind)} />
                  <span>
                    <strong>{localizeUiValue(entity.label, language)}</strong>
                    <small>{entity.table}</small>
                  </span>
                  <em>{entity.dimensions}</em>
                </button>
              ))}
            </div>
            <div className="entity-legend">
              <span>
                <i className="entity-type-dot dimension" /> {text("Dimension", "维度")}
              </span>
              <span>
                <i className="entity-type-dot fact" /> {text("Fact", "事实")}
              </span>
              <span>
                <i className="entity-type-dot bridge" /> {text("Bridge", "桥接")}
              </span>
            </div>
          </aside>

          <section className="graph-stage">
            <div className="graph-toolbar">
              <div>
                <button className="active">{text("All domains", "全部主题")}</button>
                <button>{text("Content", "内容")}</button>
                <button>{text("Engagement", "参与度")}</button>
                <button>{text("Commerce", "商业化")}</button>
              </div>
              <div>
                <button aria-label={text("Zoom out", "缩小")}>−</button>
                <span>85%</span>
                <button aria-label={text("Zoom in", "放大")}>＋</button>
                <button aria-label={text("Fit graph", "适应画布")}>⌗</button>
              </div>
            </div>
            <div className="graph-scroll">
              <div className="graph-canvas">
                <div className="graph-domain domain-content">{text("CONTENT", "内容")}</div>
                <div className="graph-domain domain-engagement">
                  {text("ENGAGEMENT", "参与度")}
                </div>
                <div className="graph-domain domain-commerce">{text("COMMERCE", "商业化")}</div>
                {GRAPH_LINKS.map((link, index) => (
                  <span
                    className="graph-link"
                    key={index}
                    style={{
                      left: link.x,
                      top: link.y,
                      width: link.width,
                      transform: `rotate(${link.angle}deg)`,
                    }}
                  />
                ))}
                {ENTITIES.map((entity) => (
                  <button
                    className={cn(
                      "graph-node",
                      entity.kind,
                      entity.name === selectedEntity && "selected",
                    )}
                    key={entity.name}
                    style={{ left: entity.x, top: entity.y }}
                    onClick={() => selectEntity(entity.name)}
                  >
                    <span className="graph-node-icon">
                      {entity.kind === "fact"
                        ? "F"
                        : entity.kind === "bridge"
                          ? "B"
                          : "D"}
                    </span>
                    <span>
                      <strong>{localizeUiValue(entity.label, language)}</strong>
                      <small>{entity.table}</small>
                    </span>
                    {entity.metrics > 0 && <em>{entity.metrics}</em>}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <aside className="entity-inspector">
            <div className="inspector-top">
              <span className={cn("entity-badge", activeEntity.kind)}>
                {activeEntity.kind === "dimension"
                  ? text("DIMENSION", "维度")
                  : activeEntity.kind === "fact"
                    ? text("FACT", "事实")
                    : text("BRIDGE", "桥接")}
              </span>
              <button aria-label={text("Close inspector", "关闭检查器")}>×</button>
            </div>
            <h2>{localizeUiValue(activeEntity.label, language)}</h2>
            <code>{activeEntity.table}</code>
            <p>
              {text(
                `Governed ${activeEntity.kind} entity owned by ${activeEntity.owner}.`,
                `这是由 ${activeEntity.owner} 负责的受治理${activeEntity.kind === "fact" ? "事实" : activeEntity.kind === "dimension" ? "维度" : "桥接"}实体。`,
              )}
            </p>
            <div className="inspector-section">
              <span className="panel-kicker">{text("CONTRACT", "契约")}</span>
              <label>
                <span>{text("Owner", "负责人")}</span>
                <input value={activeEntity.owner} readOnly />
              </label>
              <label>
                <span>{text("Grain", "数据粒度")}</span>
                <input value={activeEntity.grain} readOnly />
              </label>
              <label>
                <span>{text("Sensitivity", "敏感级别")}</span>
                <select defaultValue="internal">
                  <option value="public">{text("public", "公开")}</option>
                  <option value="internal">{text("internal", "内部")}</option>
                  <option value="restricted">{text("restricted", "受限")}</option>
                </select>
              </label>
            </div>
            <div className="inspector-section">
              <div className="inspector-section-heading">
                <span className="panel-kicker">{text("DIMENSIONS", "维度")}</span>
                <button>＋</button>
              </div>
              {[
                [text("Primary key", "主键"), activeEntity.grain.split(" + ")[0]],
                [text("Display name", "显示名称"), `${activeEntity.name}_name`],
                [text("Event date", "事件日期"), "date_key"],
              ].map(([label, field]) => (
                <div className="field-row" key={label}>
                  <span>
                    <strong>{label}</strong>
                    <code>{field}</code>
                  </span>
                  <button>···</button>
                </div>
              ))}
            </div>
            <div className="inspector-section compact">
              <div>
                <span>{text("Metrics", "指标")}</span>
                <strong>{activeEntity.metrics}</strong>
              </div>
              <div>
                <span>{text("Dimensions", "维度")}</span>
                <strong>{activeEntity.dimensions}</strong>
              </div>
              <div>
                <span>{text("Quality rules", "质量规则")}</span>
                <strong>4</strong>
              </div>
            </div>
            <button
              className="save-entity-button"
              onClick={() => toast(text(`${activeEntity.label} draft saved.`, `${localizeUiValue(activeEntity.label, language)}草稿已保存。`))}
            >
              {text("Save entity draft", "保存实体草稿")}
            </button>
          </aside>
        </div>
      )}

      {tab === "metrics" && (
        <div className="metric-catalog">
          <div className="catalog-toolbar">
            <label className="entity-search">
              <span>⌕</span>
              <input placeholder={text("Search 11 metrics…", "搜索 11 个指标…")} />
            </label>
            <button className="secondary-button">{text("Filter by domain", "按主题筛选")}</button>
            <button className="primary-button">＋ {text("New metric", "新建指标")}</button>
          </div>
          <div className="metric-catalog-grid">
            {METRICS.map((metric) => (
              <article className="metric-definition-card" key={metric.name}>
                <div className="metric-definition-top">
                  <span className="metric-function">ƒ</span>
                  <div>
                    <h3>{localizeUiValue(metric.label, language)}</h3>
                    <code>{metric.name}</code>
                  </div>
                  <span className="status-pill success">{text("VALID", "有效")}</span>
                </div>
                <p>{localizeUiValue(metric.description, language)}</p>
                <div className="metric-expression">
                  <span>{metric.aggregation}</span>
                  <code>{metric.expression}</code>
                </div>
                <footer>
                  <span>
                    {text("Entity", "实体")} <strong>{metric.entity}</strong>
                  </span>
                  <button onClick={() => toast(text(`${metric.label} opened.`, `已打开${localizeUiValue(metric.label, language)}。`))}>
                    {text("Edit →", "编辑 →")}
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </div>
      )}

      {tab === "paths" && (
        <div className="join-paths-panel">
          <div className="join-paths-intro">
            <div>
              <span className="panel-kicker">{text("FAN-OUT CONTROL", "扇出控制")}</span>
              <h2>{text("Only reviewed paths reach SQL generation", "只有经过评审的路径才能用于生成 SQL")}</h2>
              <p>
                {text(
                  "Each path declares its hop sequence and cardinality so the agent cannot invent joins or silently duplicate facts.",
                  "每条路径都声明跳转顺序和关系基数，防止智能体虚构关联或在无提示的情况下重复事实数据。",
                )}
              </p>
            </div>
            <button className="primary-button">＋ {text("Define Join Path", "定义 Join Path")}</button>
          </div>
          <div className="join-paths-list">
            {JOIN_PATHS.map((path) => (
              <article className="join-path-row" key={path.name}>
                <span className="join-path-icon">↝</span>
                <div className="join-path-name">
                  <strong>{localizeUiValue(path.label, language)}</strong>
                  <code>{path.name}</code>
                </div>
                <div className="path-flow">
                  {path.steps.map((step, index) => (
                    <span key={step}>
                      <b>{localizeUiValue(step, language)}</b>
                      {index < path.steps.length - 1 && <i>→</i>}
                    </span>
                  ))}
                </div>
                <span className="hop-count">{path.hops} {text("hops", "跳")}</span>
                <span className="status-pill success">{localizeUiValue(path.risk, language)}</span>
                <button aria-label={text(`Edit ${path.label}`, `编辑${localizeUiValue(path.label, language)}`)}>···</button>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AskView({
  domain,
  hasSources,
  query,
  setQuery,
  submitQuery,
  runQuery,
  isRunning,
  runStage,
  result,
  copySql,
  downloadResult,
  runs,
  selectRun,
  connection,
}: {
  domain: DataDomain;
  hasSources: boolean;
  query: string;
  setQuery: (value: string) => void;
  submitQuery: (event: FormEvent) => void;
  runQuery: (value?: string) => Promise<void>;
  isRunning: boolean;
  runStage: number;
  result: QueryResult;
  copySql: () => void;
  downloadResult: () => void;
  runs: RunRecord[];
  selectRun: (run: RunRecord) => void;
  connection: ConnectionState;
}) {
  const { language, text } = useLanguage();
  if (!domain.isSample) {
    return (
      <div className="page domain-analysis-page">
        <PageHeader
          eyebrow={text("DOMAIN ANALYSIS", "数据域分析")}
          title={`${domain.name} · ${text("Ask & Analyze", "问答分析")}`}
          description={text("Questions execute only against the active domain after its semantic contract and runtime connector are published.", "只有发布当前数据域的语义契约和运行连接器后，问题才能在该数据域中执行。")}
          action={
            <span className="status-pill neutral">
              {hasSources ? text("SEMANTICS REQUIRED", "需要语义契约") : text("DATA REQUIRED", "需要数据")}
            </span>
          }
        />
        <section className="panel domain-analysis-lock">
          <div className="analysis-lock-visual">
            <span>✦</span>
            <i />
            <b>⌘</b>
            <i />
            <em>SQL</em>
          </div>
          <div>
            <span className="panel-kicker">{text("SAFE BY DEFAULT", "默认安全")}</span>
            <h2>
              {hasSources
                ? text("Publish the semantic contract to unlock questions", "发布语义契约后才能启用问答")
                : text("This domain needs data before it can answer", "该数据域接入数据后才能回答问题")}
            </h2>
            <p>
              {text("NexusQL will not fall back to the Anime Streaming sample or invent joins when this domain is incomplete. Domain context, meaning, policy, and evidence must travel together.", "当前数据域不完整时，NexusQL 不会回退到 Anime Streaming 示例或虚构连接。数据域上下文、业务含义、策略和证据必须始终一致。")}
            </p>
            <div className="analysis-lock-checks">
              {[
                [text("Domain selected", "已选择数据域"), true],
                [text("Source available", "数据源可用"), hasSources],
                [text("Semantic contract published", "语义契约已发布"), false],
                [text("Execution connector ready", "执行连接器就绪"), false],
              ].map(([label, ready]) => (
                <span key={String(label)} className={cn(ready && "ready")}>
                  {ready ? "✓" : "○"} {label}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }

  const maxValue = Math.max(
    ...result.rows.map((row) => Number(row[1]) || 0),
    1,
  );

  return (
    <div className="ask-workspace">
      <aside className="conversation-rail">
        <button className="new-query-button" onClick={() => setQuery("")}>
          <span>＋</span> {text("New analysis", "新建分析")}
        </button>
        <div className="conversation-label">{text("RECENT", "最近运行")}</div>
        {runs.map((run) => (
          <button
            className="conversation-item"
            key={run.id}
            onClick={() => selectRun(run)}
          >
            <span>✦</span>
            <span>
              <strong>{localizeUiValue(run.question, language)}</strong>
              <small>{localizeUiValue(run.time, language)}</small>
            </span>
          </button>
        ))}
        <div className="conversation-bottom">
          <span className="shield-icon">◆</span>
          <div>
            <strong>{text("Governed mode", "治理模式")}</strong>
            <small>{text("Semantic model required", "必须使用语义模型")}</small>
          </div>
        </div>
      </aside>

      <section className="analysis-canvas">
        <div className="analysis-header">
          <div>
            <div className="eyebrow">
              <span className="pulse-dot" />
              {connection === "live" ? text("LIVE ANALYSIS", "实时分析") : text("INTERACTIVE DEMO", "交互演示")}
            </div>
            <h1>{text("Ask & Analyze", "问答分析")}</h1>
          </div>
          <div className="analysis-actions">
            <button className="secondary-button" onClick={downloadResult}>
              ↓ {text("Export", "导出")}
            </button>
            <button className="icon-button" aria-label={text("More actions", "更多操作")}>
              ···
            </button>
          </div>
        </div>

        <form className="ask-composer" onSubmit={submitQuery}>
          <span className="query-spark">✦</span>
          <textarea
            value={localizeUiValue(query, language)}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={text("Ask a business question…", "输入一个业务问题…")}
            aria-label={text("Business question", "业务问题")}
            rows={2}
          />
          <div className="composer-options">
            <span className="option-chip">{domain.name}</span>
            <span className="option-chip">{text("Auto complexity", "自动复杂度")}</span>
            <span className="option-chip">{text("Report on", "生成报告")}</span>
          </div>
          <button type="submit" disabled={isRunning || !query.trim()}>
            {isRunning ? text("Running…", "运行中…") : text("Run", "运行")}
            <span>↵</span>
          </button>
        </form>

        <div className="question-suggestions">
          {EXAMPLE_QUESTIONS.slice(1).map((item) => (
            <button key={item} onClick={() => void runQuery(item)}>
              {localizeUiValue(item, language)}
            </button>
          ))}
        </div>

        {isRunning ? (
          <div className="run-progress-panel">
            <div className="run-progress-orb">NQ</div>
            <h2>{text("Building a governed answer", "正在构建受治理答案")}</h2>
            <p>{text("Every stage produces evidence before SQL can execute.", "SQL 执行前，每个阶段都会生成可审计证据。")}</p>
            <div className="run-stage-list">
              {[
                [text("Resolve semantics", "解析语义"), text("Matched metrics, entities and grain", "匹配指标、实体和数据粒度")],
                [text("Plan Join Paths", "规划 Join Path"), text("Selected reviewed relationships", "选择经过评审的关系")],
                [text("Govern SQL", "治理 SQL"), text("AST policy and bounded preview", "AST 策略与有界预览")],
                [text("Validate answer", "验证答案"), text("Result quality and report artifacts", "结果质量与报告产物")],
              ].map(([label, detail], index) => {
                const number = index + 1;
                return (
                  <div
                    className={cn(
                      "run-stage",
                      runStage === number && "active",
                      runStage > number && "complete",
                    )}
                    key={label}
                  >
                    <span>{runStage > number ? "✓" : number}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </div>
                    {runStage === number && <i />}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <article className="answer-card">
              <div className="answer-avatar">NQ</div>
              <div className="answer-content">
                <div className="answer-meta">
                  <strong>NexusQL</strong>
                  <span className="status-pill success">{text("GOVERNED", "已治理")}</span>
                  <small>{result.runId}</small>
                </div>
                <p>{localizeUiValue(result.explanation, language)}</p>
                <div className="answer-highlights">
                  <div>
                    <span>{text("Top genre", "观看时长最高类型")}</span>
                    <strong>{localizeUiValue(String(result.rows[0]?.[0] ?? "Fantasy"), language)}</strong>
                  </div>
                  <div>
                    <span>{text("Watch hours", "观看时长")}</span>
                    <strong>
                      {Number(result.rows[0]?.[1] ?? 0).toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>{text("Best completion", "最高完播率")}</span>
                    <strong>
                      {Math.max(
                        ...result.rows.map((row) => Number(row[2]) || 0),
                      ).toFixed(1)}
                      %
                    </strong>
                  </div>
                </div>
              </div>
            </article>

            <div className="result-grid">
              <section className="panel result-chart-panel">
                <div className="panel-heading">
                  <div>
                    <span className="panel-kicker">{text("RESULT VISUALIZATION", "结果可视化")}</span>
                    <h2>{text("Watch hours by genre", "各类型观看时长")}</h2>
                  </div>
                  <div className="segmented small">
                    <button className="active">{text("Bar", "柱状图")}</button>
                    <button>{text("Table", "表格")}</button>
                  </div>
                </div>
                <div className="horizontal-chart">
                  {result.rows.slice(0, 8).map((row, index) => {
                    const value = Number(row[1]) || 0;
                    return (
                      <div className="horizontal-bar-row" key={`${row[0]}-${index}`}>
                        <span>{localizeUiValue(String(row[0]), language)}</span>
                        <div>
                          <i style={{ width: `${(value / maxValue) * 100}%` }} />
                        </div>
                        <strong>{value.toLocaleString()}</strong>
                      </div>
                    );
                  })}
                </div>
                <div className="chart-footnote">
                  <span>
                    <i className="legend-primary" /> {text("Watch hours", "观看时长")}
                  </span>
                  <span>{text("Valid sessions only · Rounded to 1 decimal", "仅统计有效会话 · 保留 1 位小数")}</span>
                </div>
              </section>

              <section className="panel sql-panel">
                <div className="panel-heading">
                  <div>
                    <span className="panel-kicker">{text("GENERATED SQL", "生成的 SQL")}</span>
                    <h2>{text("Auditable query", "可审计查询")}</h2>
                  </div>
                  <button className="copy-button" onClick={copySql}>
                    ⧉ {text("Copy", "复制")}
                  </button>
                </div>
                <pre>
                  <code>{result.sql}</code>
                </pre>
              </section>
            </div>

            <section className="panel result-table-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">{text("REVIEWED ROWS", "已审核结果行")}</span>
                  <h2>{text("Query result", "查询结果")}</h2>
                </div>
                <span className="row-count">{result.rowCount} {text("rows", "行")}</span>
              </div>
              <div className="result-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {result.columns.map((column) => (
                        <th key={column}>{localizeUiValue(column, language)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>
                            {typeof cell === "number"
                              ? cell.toLocaleString()
                              : typeof cell === "string"
                                ? localizeUiValue(cell, language)
                                : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </section>

      <aside className="trust-rail">
        <div className="trust-heading">
          <div>
            <span className="panel-kicker">{text("TRUST TRACE", "可信追踪")}</span>
            <strong>{text("Why this answer is safe", "为什么这个答案可信")}</strong>
          </div>
          <span className="trust-score">100</span>
        </div>
        <div className="trust-section">
          <span className="trust-section-label">{text("SEMANTIC MATCH", "语义匹配")}</span>
          <div className="trust-card">
            <span className="trust-card-icon metric">ƒ</span>
            <div>
              <strong>watch_hours</strong>
              <small>{text("SUM · watch_session", "求和 · 观看会话")}</small>
            </div>
            <span>99%</span>
          </div>
          <div className="trust-card">
            <span className="trust-card-icon metric">%</span>
            <div>
              <strong>completion_rate</strong>
              <small>{text("RATIO · watch_session", "比率 · 观看会话")}</small>
            </div>
            <span>98%</span>
          </div>
        </div>
        <div className="trust-section">
          <span className="trust-section-label">{text("JOIN PATH", "关联路径")}</span>
          <div className="mini-path">
            <span>{text("Watch", "观看会话")}</span>
            <i>→</i>
            <span>{text("Episode", "剧集")}</span>
            <i>→</i>
            <span>{text("Anime", "动漫")}</span>
          </div>
          <div className="trust-note success">
            <span>✓</span>
            <p>
              {text("Reviewed path", "路径已评审")}
              <small>{text("No fan-out risk detected", "未检测到扇出风险")}</small>
            </p>
          </div>
        </div>
        <div className="trust-section">
          <span className="trust-section-label">{text("SQL POLICY", "SQL 策略")}</span>
          {[
            [text("Read-only AST", "只读 AST"), text("Passed", "通过")],
            [text("Table scope", "数据表范围"), text("Passed", "通过")],
            [text("Join budget", "关联预算"), "4 / 5"],
            [text("Result limit", "结果行数限制"), "6 / 500"],
            [text("Sensitive columns", "敏感字段"), text("None", "无")],
          ].map(([label, value]) => (
            <div className="policy-check" key={label}>
              <span>✓</span>
              <strong>{label}</strong>
              <small>{value}</small>
            </div>
          ))}
        </div>
        <div className="trust-section">
          <span className="trust-section-label">{text("QUALITY", "质量")}</span>
          <div className="quality-score">
            <div>
              <strong>96</strong>
              <span>/100</span>
            </div>
            <p>
              {text("Result quality", "结果质量")}
              <small>{text("Grain, nulls and reconciliation passed", "粒度、空值和对账检查均通过")}</small>
            </p>
          </div>
        </div>
        <button className="trace-download" onClick={downloadResult}>
          ↓ {text("Download complete run artifact", "下载完整运行产物")}
        </button>
      </aside>
    </div>
  );
}

function RunsView({
  runs,
  filter,
  setFilter,
  selectRun,
  downloadResult,
}: {
  runs: RunRecord[];
  filter: "All" | "Passed" | "Blocked";
  setFilter: (filter: "All" | "Passed" | "Blocked") => void;
  selectRun: (run: RunRecord) => void;
  downloadResult: () => void;
}) {
  const { text } = useLanguage();
  return (
    <div className="page">
      <PageHeader
        eyebrow={text("AUDITABILITY", "可审计性")}
        title={text("Run History", "运行历史")}
        description={text("Every route, semantic match, policy decision, SQL candidate, and quality result is preserved as evidence.", "每次路由、语义匹配、策略决策、SQL 候选和质量结果都会作为证据留存。")}
        action={
          <button className="secondary-button" onClick={downloadResult}>
            ↓ {text("Export history", "导出历史")}
          </button>
        }
      />

      <div className="run-summary-grid">
        {[
          [text("Total runs", "运行总数"), "128", text("Last 30 days", "最近 30 天")],
          [text("Pass rate", "通过率"), "96.1%", "+2.4%"],
          [text("Policy blocks", "策略阻断"), "5", text("Expected denials", "符合预期的拒绝")],
          [text("Median latency", "延迟中位数"), "1.72s", "−180ms"],
        ].map(([label, value, detail]) => (
          <div className="run-summary-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>

      <section className="panel runs-panel">
        <div className="runs-toolbar">
          <div className="segmented">
            {(["All", "Passed", "Blocked"] as const).map((item) => (
              <button
                key={item}
                className={cn(filter === item && "active")}
                onClick={() => setFilter(item)}
              >
                {item === "All" ? text("All", "全部") : item === "Passed" ? text("Passed", "已通过") : text("Blocked", "已阻断")}
              </button>
            ))}
          </div>
          <label className="table-search wide">
            <span>⌕</span>
            <input placeholder={text("Search questions or run IDs…", "搜索问题或运行 ID…")} />
          </label>
          <button className="secondary-button">{text("Last 30 days", "最近 30 天")} ⌄</button>
        </div>
        <div className="runs-table">
          <div className="runs-table-head">
            <span>{text("Status", "状态")}</span>
            <span>{text("Question", "问题")}</span>
            <span>{text("Model", "模型")}</span>
            <span>{text("Rows", "行数")}</span>
            <span>{text("Duration", "耗时")}</span>
            <span>{text("When", "时间")}</span>
            <span />
          </div>
          {runs.map((run) => (
            <button
              className="runs-table-row"
              key={run.id}
              onClick={() => selectRun(run)}
            >
              <span>
                <span
                  className={cn(
                    "status-pill",
                    run.status === "Passed" ? "success" : "danger",
                  )}
                >
                  {run.status === "Passed" ? text("Passed", "已通过") : run.status === "Blocked" ? text("Blocked", "已阻断") : text("Running", "运行中")}
                </span>
              </span>
              <span className="run-question-cell">
                <strong>{run.question}</strong>
                <code>{run.id}</code>
              </span>
              <span>{run.model}</span>
              <span className="mono">{run.rows}</span>
              <span className="mono">{run.duration}</span>
              <span>{run.time}</span>
              <span>→</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function UploadModal({
  domain,
  step,
  files,
  isProfiling,
  reviewed,
  validated,
  semanticDraft,
  setSemanticDraft,
  resetValidation,
  fileInputRef,
  close,
  handleFiles,
  profileFiles,
  setStep,
  setReviewed,
  validateSemantic,
  publishUpload,
}: {
  domain: DataDomain;
  step: number;
  files: File[];
  isProfiling: boolean;
  reviewed: boolean;
  validated: boolean;
  semanticDraft: SemanticDraft;
  setSemanticDraft: (
    value: SemanticDraft | ((current: SemanticDraft) => SemanticDraft),
  ) => void;
  resetValidation: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  close: () => void;
  handleFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  profileFiles: () => Promise<void>;
  setStep: (step: number) => void;
  setReviewed: (value: boolean) => void;
  validateSemantic: () => Promise<void>;
  publishUpload: () => Promise<void>;
}) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal upload-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
      >
        <div className="modal-header">
          <div>
            <span className="panel-kicker">GOVERNED INGESTION</span>
            <h2 id="upload-title">Add a data source</h2>
            <p>
              Destination: <strong>{domain.name}</strong> · Data cannot publish
              without reviewed business meaning.
            </p>
          </div>
          <button className="modal-close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>

        <div className="upload-stepper">
          {[
            ["1", "Upload"],
            ["2", "Profile"],
            ["3", "Semantic contract"],
          ].map(([number, label], index) => (
            <button
              key={label}
              className={cn(
                step === index + 1 && "active",
                step > index + 1 && "complete",
              )}
              onClick={() => {
                if (index === 0 || files.length) setStep(index + 1);
              }}
            >
              <span>{step > index + 1 ? "✓" : number}</span>
              {label}
            </button>
          ))}
        </div>

        {step === 1 && (
          <div className="upload-step-content">
            <button
              className="drop-zone"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="upload-cloud">↑</span>
              <strong>Drop SQLite, CSV, or Parquet files here</strong>
              <p>or click to browse · up to 25 MB per file</p>
              <span className="browse-button">Choose files</span>
            </button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              multiple
              accept=".sqlite,.db,.csv,.parquet"
              onChange={handleFiles}
            />
            {files.length > 0 && (
              <div className="selected-files">
                {files.map((file) => (
                  <div key={`${file.name}-${file.size}`}>
                    <span className="file-kind">
                      {file.name.split(".").pop()?.slice(0, 3).toUpperCase()}
                    </span>
                    <span>
                      <strong>{file.name}</strong>
                      <small>{formatBytes(file.size)}</small>
                    </span>
                    <span className="check-mark">✓</span>
                  </div>
                ))}
              </div>
            )}
            <div className="upload-modal-footer">
              <span>
                {files.length
                  ? `${files.length} file(s) · ${formatBytes(totalBytes)}`
                  : "No files selected"}
              </span>
              <button
                className="primary-button"
                disabled={!files.length || isProfiling}
                onClick={() => void profileFiles()}
              >
                {isProfiling ? "Profiling…" : "Profile files →"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="upload-step-content profile-content">
            <div className="profile-success">
              <span>✓</span>
              <div>
                <strong>Physical profile complete</strong>
                <p>
                  NexusQL inferred a draft only. Business definitions still
                  require human review.
                </p>
              </div>
            </div>
            <div className="profile-stats-grid">
              <div>
                <span>Detected tables</span>
                <strong>{Math.max(files.length, 1)}</strong>
              </div>
              <div>
                <span>Candidate grain</span>
                <strong>record_id</strong>
              </div>
              <div>
                <span>Dimensions</span>
                <strong>7</strong>
              </div>
              <div>
                <span>Quality warnings</span>
                <strong className="warning-text">2</strong>
              </div>
            </div>
            <div className="profile-table-preview">
              <div>
                <span>Column</span>
                <span>Type</span>
                <span>Semantic role</span>
                <span>Quality</span>
              </div>
              {[
                ["record_id", "INTEGER", "Primary key", "Unique"],
                ["entity_id", "INTEGER", "Entity key", "99.9%"],
                ["recorded_at", "TIMESTAMP", "Time dimension", "100%"],
                ["amount", "DECIMAL", "Candidate measure", "2 outliers"],
              ].map((row) => (
                <div key={row[0]}>
                  {row.map((cell, index) => (
                    <span key={index}>{cell}</span>
                  ))}
                </div>
              ))}
            </div>
            <div className="upload-modal-footer">
              <button className="secondary-button" onClick={() => setStep(1)}>
                ← Back
              </button>
              <button className="primary-button" onClick={() => setStep(3)}>
                Review semantic draft →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="upload-step-content semantic-review-content">
            <div className="mandatory-banner">
              <span>!</span>
              <div>
                <strong>Semantic review is mandatory</strong>
                <p>
                  Publish stays locked until entity grain, dimensions, metrics,
                  ownership, and quality rules pass validation.
                </p>
              </div>
            </div>
            <div className="semantic-draft-grid">
              <div className="semantic-draft-form">
                <label>
                  <span>Entity name</span>
                  <input
                    value={semanticDraft.entity}
                    onChange={(event) => {
                      setSemanticDraft((current) => ({
                        ...current,
                        entity: event.target.value,
                      }));
                      setReviewed(false);
                      resetValidation();
                    }}
                  />
                </label>
                <label>
                  <span>Business description</span>
                  <textarea
                    rows={3}
                    value={semanticDraft.description}
                    onChange={(event) => {
                      setSemanticDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }));
                      setReviewed(false);
                      resetValidation();
                    }}
                  />
                </label>
                <div className="form-pair">
                  <label>
                    <span>Owner</span>
                    <input
                      value={semanticDraft.owner}
                      onChange={(event) => {
                        setSemanticDraft((current) => ({
                          ...current,
                          owner: event.target.value,
                        }));
                        setReviewed(false);
                        resetValidation();
                      }}
                    />
                  </label>
                  <label>
                    <span>Grain</span>
                    <input
                      value={semanticDraft.grain}
                      onChange={(event) => {
                        setSemanticDraft((current) => ({
                          ...current,
                          grain: event.target.value,
                        }));
                        setReviewed(false);
                        resetValidation();
                      }}
                    />
                  </label>
                </div>
                <div className="form-pair">
                  <label>
                    <span>Primary key</span>
                    <input
                      value={semanticDraft.primaryKey}
                      onChange={(event) => {
                        setSemanticDraft((current) => ({
                          ...current,
                          primaryKey: event.target.value,
                        }));
                        setReviewed(false);
                        resetValidation();
                      }}
                    />
                  </label>
                  <label>
                    <span>Sensitivity</span>
                    <select
                      value={semanticDraft.sensitivity}
                      onChange={(event) => {
                        setSemanticDraft((current) => ({
                          ...current,
                          sensitivity: event.target
                            .value as SemanticDraft["sensitivity"],
                        }));
                        setReviewed(false);
                        resetValidation();
                      }}
                    >
                      <option>public</option>
                      <option>internal</option>
                      <option>restricted</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="semantic-draft-summary">
                <span className="panel-kicker">GENERATED CONTRACT</span>
                <div>
                  <span>Entity</span>
                  <strong>1</strong>
                </div>
                <div>
                  <span>Dimensions</span>
                  <strong>{semanticDraft.dimensions.length}</strong>
                </div>
                <div>
                  <span>Draft metrics</span>
                  <strong>{semanticDraft.metrics.length}</strong>
                </div>
                <div>
                  <span>Quality rules</span>
                  <strong>6</strong>
                </div>
                {semanticDraft.metrics.map((metric) => (
                  <code key={metric.name}>{metric.name}</code>
                ))}
              </div>
            </div>
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => {
                  setReviewed(event.target.checked);
                  if (!event.target.checked) {
                    resetValidation();
                  }
                }}
              />
              <span>
                <strong>I reviewed the business meaning and grain</strong>
                <small>
                  The owner confirms these definitions are safe for analytical
                  use.
                </small>
              </span>
            </label>
            <div className="validation-row">
              <button
                className="secondary-button"
                disabled={!reviewed}
                onClick={() => void validateSemantic()}
              >
                {validated ? "✓ Contract validated" : "Run contract checks"}
              </button>
              <div>
                <span
                  className={cn(
                    "validation-light",
                    validated && "passed",
                  )}
                />
                {validated
                  ? "All blocking checks passed"
                  : "Validation required"}
              </div>
            </div>
            <div className="upload-modal-footer">
              <button className="secondary-button" onClick={() => setStep(2)}>
                ← Back
              </button>
              <button
                className="primary-button success-button"
                disabled={!reviewed || !validated}
                onClick={() => void publishUpload()}
              >
                Publish data + semantics
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateDomainModal({
  close,
  createDomain,
}: {
  close: () => void;
  createDomain: (input: {
    name: string;
    description: string;
    owner: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("Workspace admin");
  const [isCreating, setIsCreating] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2 || isCreating) return;
    setIsCreating(true);
    await createDomain({
      name: name.trim(),
      description:
        description.trim() ||
        "A governed business context for data, semantics, policy, and trusted analysis.",
      owner: owner.trim() || "Workspace admin",
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="modal create-domain-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-domain-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="modal-header">
          <div>
            <span className="panel-kicker">NEW GOVERNANCE BOUNDARY</span>
            <h2 id="create-domain-title">Create a data domain</h2>
            <p>
              Sources, semantics, policies, and run history stay isolated inside
              this context.
            </p>
          </div>
          <button
            className="modal-close"
            onClick={close}
            type="button"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="create-domain-body">
          <div className="domain-name-preview">
            <span>
              {name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((word) => word[0])
                .join("")
                .toUpperCase() || "DD"}
            </span>
            <div>
              <strong>{name || "Untitled data domain"}</strong>
              <code>
                {name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "") || "domain-slug"}
              </code>
            </div>
          </div>
          <label>
            <span>Domain name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Retail Commerce"
              maxLength={80}
              required
            />
            <small>Use a stable business context, not a database name.</small>
          </label>
          <label>
            <span>Purpose</span>
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What decisions and analytical questions belong here?"
            />
          </label>
          <label>
            <span>Domain owner</span>
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="Team or accountable owner"
            />
          </label>
          <div className="domain-boundary-note">
            <span>◆</span>
            <p>
              Creating the domain does not copy sample semantics. The next step
              is to upload this domain’s own data and review its semantic
              contract.
            </p>
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={name.trim().length < 2 || isCreating}
          >
            {isCreating ? "Creating…" : "Create & add data →"}
          </button>
        </div>
      </form>
    </div>
  );
}

function SettingsModal({
  connection,
  close,
}: {
  connection: ConnectionState;
  close: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <div>
            <span className="panel-kicker">WORKSPACE</span>
            <h2 id="settings-title">Runtime settings</h2>
            <p>Control the live NexusQL connection and query defaults.</p>
          </div>
          <button className="modal-close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <div className="settings-status-card">
          <span
            className={cn(
              "settings-status-icon",
              connection === "live" && "live",
            )}
          >
            {connection === "live" ? "✓" : "◇"}
          </span>
          <div>
            <strong>
              {connection === "live"
                ? "NexusQL backend connected"
                : "Interactive demo mode"}
            </strong>
            <p>
              {connection === "live"
                ? "Queries use the configured Python service."
                : "Start `queryforge --serve-api` and set QUERYFORGE_API_URL to enable live analysis."}
            </p>
          </div>
          <span
            className={cn(
              "status-pill",
              connection === "live" ? "success" : "neutral",
            )}
          >
            {connection === "live" ? "LIVE" : "DEMO"}
          </span>
        </div>
        <div className="settings-form">
          <label>
            <span>Model profile</span>
            <select defaultValue="auto">
              <option value="auto">Auto route</option>
              <option value="qwen">Qwen Plus</option>
              <option value="openai">GPT-4.1 mini</option>
              <option value="claude">Claude Sonnet</option>
            </select>
          </label>
          <label>
            <span>Complexity</span>
            <select defaultValue="auto">
              <option value="auto">Auto</option>
              <option value="minimal">Minimal</option>
              <option value="complex">Complex</option>
            </select>
          </label>
          <label className="setting-toggle">
            <span>
              <strong>Require semantic model</strong>
              <small>Block schema-only analytics</small>
            </span>
            <input type="checkbox" defaultChecked disabled />
          </label>
          <label className="setting-toggle">
            <span>
              <strong>Create report artifacts</strong>
              <small>Generate shareable HTML evidence</small>
            </span>
            <input type="checkbox" defaultChecked />
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={close}>
            Cancel
          </button>
          <button className="primary-button" onClick={close}>
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}
