import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  Radar,
  RefreshCcw,
  Send,
  SquareArrowOutUpRight,
  Server,
  ShieldCheck,
  Sparkles,
  Search,
} from 'lucide-react';
import { BraveChecker } from './BraveChecker';

type ApiFormat = 'openai' | 'claude';
type StatusState = 'idle' | 'running' | 'success' | 'failed';
type ModelCheckState = 'idle' | 'testing' | 'success' | 'failed';

type ProbeStatus = {
  label: string;
  state: StatusState;
  detail: string;
};

type ModelCheckResult = {
  format: ApiFormat;
  model: string;
  state: ModelCheckState;
  detail: string;
  checkedAt?: string;
};

type FormatResult = {
  models: string[];
  error?: string;
};

type TestResult = {
  supportedFormats: ApiFormat[];
  formatResults: Record<ApiFormat, FormatResult>;
  error?: string;
  endpoint: string;
  statuses: ProbeStatus[];
  modelChecks: Record<string, ModelCheckResult>;
};

type HistoryEntry = {
  id: string;
  baseUrl: string;
  apiKey: string;
  supportedFormats: ApiFormat[];
  format?: ApiFormat;
  endpoint: string;
  modelCount: number;
  createdAt: string;
};

type ProbeOutcome = {
  supportedFormats: ApiFormat[];
  formatResults: Record<ApiFormat, FormatResult>;
  statuses: ProbeStatus[];
  endpoint: string;
};

const STORAGE_KEY = 'llm-api-checker.form';
const HISTORY_STORAGE_KEY = 'llm-api-checker.history';
const DEFAULT_BASE_URL = 'https://api.openai.com';
const HISTORY_LIMIT = 8;

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function buildModelsUrl(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

function buildOpenAiTestUrl(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
}

function buildClaudeTestUrl(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}

function parseModelIds(data: unknown) {
  if (!data || typeof data !== 'object') {
    return [];
  }

  if ('data' in data && Array.isArray(data.data)) {
    return data.data
      .map((item) => (typeof item === 'object' && item ? item.id ?? item.name : null))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  if (Array.isArray(data)) {
    return data
      .map((item) => (typeof item === 'object' && item ? item.id ?? item.name : null))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  return [];
}

function formatAxiosError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const responseMessage =
      typeof error.response?.data === 'object' && error.response?.data && 'error' in error.response.data
        ? typeof error.response.data.error === 'string'
          ? error.response.data.error
          : typeof error.response.data.error === 'object' &&
              error.response.data.error &&
              'message' in error.response.data.error &&
              typeof error.response.data.error.message === 'string'
            ? error.response.data.error.message
            : undefined
        : undefined;

    return (
      responseMessage ??
      (error.response
        ? `Request failed with status ${error.response.status}.`
        : error.message || 'Network request failed.')
    );
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected request failure.';
}

function getProxyUrl() {
  return import.meta.env.VITE_PROXY_URL || '/__proxy';
}

async function proxyGet(targetUrl: string, headers: Record<string, string>) {
  const response = await axios.get(getProxyUrl(), {
    params: { url: targetUrl },
    headers,
    timeout: 15000,
  });

  return response.data;
}

async function proxyPost(targetUrl: string, headers: Record<string, string>, data: unknown) {
  const response = await axios.post(getProxyUrl(), data, {
    params: { url: targetUrl },
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    timeout: 20000,
  });

  return response.data;
}

function createInitialStatuses(): ProbeStatus[] {
  return [
    {
      label: '通过后端代理转发请求',
      state: 'running',
      detail: '通过同源后端服务转发请求以解决浏览器侧 CORS 跨域限制。',
    },
    {
      label: '探测 OpenAI 兼容的模型端点',
      state: 'idle',
      detail: '验证 Authorization Bearer 流程与 `/v1/models` 的响应结构。',
    },
    {
      label: '探测 Claude 兼容的模型端点',
      state: 'idle',
      detail: '使用 `x-api-key` + `anthropic-version` 请求头检测同一端点。',
    },
  ];
}

function createEmptyFormatResults(): Record<ApiFormat, FormatResult> {
  return {
    openai: { models: [] },
    claude: { models: [] },
  };
}

function buildModelCheckKey(format: ApiFormat, model: string) {
  return `${format}:${model}`;
}

function getFormatLabel(format: ApiFormat) {
  return format === 'openai' ? 'OpenAI' : 'Claude';
}

function getCcSwitchApp(format: ApiFormat) {
  return format === 'openai' ? 'codex' : 'claude';
}

function getProviderName(baseUrl: string, format: ApiFormat, model?: string) {
  try {
    const host = new URL(baseUrl).host;
    return model ? `${host} · ${getFormatLabel(format)} · ${model}` : `${host} · ${getFormatLabel(format)}`;
  } catch {
    return model ? `${getFormatLabel(format)} · ${model}` : getFormatLabel(format);
  }
}

function buildCcSwitchImportUrl(baseUrl: string, apiKey: string, format: ApiFormat) {
  const params = new URLSearchParams({
    resource: 'provider',
    app: getCcSwitchApp(format),
    name: getProviderName(baseUrl, format),
    endpoint: normalizeBaseUrl(baseUrl),
    apiKey: apiKey.trim(),
    homepage: window.location.href,
  });

  return `ccswitch://v1/import?${params.toString()}`;
}

async function detectModels(
  cleanBaseUrl: string,
  apiKey: string,
  onProgress: (result: TestResult) => void,
): Promise<ProbeOutcome> {
  const endpoint = buildModelsUrl(cleanBaseUrl);
  const initialStatuses = createInitialStatuses();
  const trimmedKey = apiKey.trim();
  const formatResults = createEmptyFormatResults();
  const statuses = [...initialStatuses];
  statuses[0] = { ...statuses[0], state: 'success' };
  statuses[1] = { ...statuses[1], state: 'running' };

  onProgress({
    supportedFormats: [],
    formatResults,
    endpoint,
    statuses,
    modelChecks: {},
  });

  let openAiMessage = '';
  try {
    const openAiData = await proxyGet(endpoint, {
      Authorization: `Bearer ${trimmedKey}`,
    });
    const openAiModels = parseModelIds(openAiData);

    if (openAiModels.length > 0) {
      formatResults.openai = { models: openAiModels };
      statuses[1] = {
        ...statuses[1],
        state: 'success',
        detail: `从 OpenAI 兼容响应中检测到 ${openAiModels.length} 个模型。`,
      };
    } else {
      throw new Error('已收到响应，但未找到模型标识。');
    }
  } catch (openAiError) {
    openAiMessage = formatAxiosError(openAiError);
    formatResults.openai = { models: [], error: openAiMessage };
    statuses[1] = {
      ...statuses[1],
      state: 'failed',
      detail: openAiMessage,
    };
  }

  statuses[2] = { ...statuses[2], state: 'running' };
  onProgress({
    supportedFormats: formatResults.openai.models.length > 0 ? ['openai'] : [],
    formatResults: {
      openai: { ...formatResults.openai },
      claude: { ...formatResults.claude },
    },
    endpoint,
    statuses: [...statuses],
    modelChecks: {},
  });

  let claudeMessage = '';
  try {
    const claudeData = await proxyGet(endpoint, {
      'x-api-key': trimmedKey,
      'anthropic-version': '2023-06-01',
    });
    const claudeModels = parseModelIds(claudeData);

    if (claudeModels.length > 0) {
      formatResults.claude = { models: claudeModels };
      statuses[2] = {
        ...statuses[2],
        state: 'success',
        detail: `从 Claude 兼容响应中检测到 ${claudeModels.length} 个模型。`,
      };
    } else {
      throw new Error('已收到响应，但未找到 Claude 兼容的模型标识。');
    }
  } catch (claudeError) {
    claudeMessage = formatAxiosError(claudeError);
    formatResults.claude = { models: [], error: claudeMessage };
    statuses[2] = {
      ...statuses[2],
      state: 'failed',
      detail: claudeMessage,
    };
  }

  const supportedFormats = (['openai', 'claude'] as const).filter(
    (format) => formatResults[format].models.length > 0,
  );

  if (supportedFormats.length === 0) {
    throw new Error(
      `端点有响应，但未匹配到 OpenAI 或 Claude 的模型发现。OpenAI 探测：${openAiMessage} Claude 探测：${claudeMessage}`,
    );
  }

  return {
    supportedFormats,
    formatResults,
    endpoint,
    statuses,
  };
}

async function probeModelAvailability(
  cleanBaseUrl: string,
  apiKey: string,
  format: ApiFormat,
  model: string,
) {
  const trimmedKey = apiKey.trim();

  if (format === 'openai') {
    await proxyPost(
      buildOpenAiTestUrl(cleanBaseUrl),
      { Authorization: `Bearer ${trimmedKey}` },
      {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      },
    );

    return '模型已成功返回响应。';
  }

  await proxyPost(
    buildClaudeTestUrl(cleanBaseUrl),
    {
      'x-api-key': trimmedKey,
      'anthropic-version': '2023-06-01',
    },
    {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    },
  );

  return '模型已成功返回响应。';
}

function maskApiKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 10) {
    return trimmed;
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function saveHistoryEntry(entry: HistoryEntry) {
  const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
  const existing = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  const deduped = existing.filter(
    (item) => !(item.baseUrl === entry.baseUrl && item.apiKey === entry.apiKey),
  );
  const next = [entry, ...deduped].slice(0, HISTORY_LIMIT);
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function LLMChecker() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [activeModelTest, setActiveModelTest] = useState<string | null>(null);
  const [isBatchTestingModels, setIsBatchTestingModels] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { baseUrl?: string; apiKey?: string };
        if (parsed.baseUrl) {
          setBaseUrl(parsed.baseUrl);
        }
        if (parsed.apiKey) {
          setApiKey(parsed.apiKey);
        }
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }

    const historyRaw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (historyRaw) {
      try {
        setHistoryEntries(JSON.parse(historyRaw) as HistoryEntry[]);
      } catch {
        window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        baseUrl,
        apiKey,
      }),
    );
  }, [apiKey, baseUrl]);

  const cleanBaseUrl = normalizeBaseUrl(baseUrl);
  const modelsEndpoint = cleanBaseUrl ? buildModelsUrl(cleanBaseUrl) : '';
  const canSubmit = Boolean(cleanBaseUrl && apiKey.trim() && !isLoading);
  const canRunModelChecks =
    !isLoading &&
    !isBatchTestingModels &&
    activeModelTest === null &&
    result !== null &&
    result.supportedFormats.length > 0;

  const runTest = async (options?: { baseUrl?: string; apiKey?: string; historyId?: string | null }) => {
    const nextBaseUrl = options?.baseUrl ?? baseUrl;
    const nextApiKey = options?.apiKey ?? apiKey;
    const normalizedBaseUrl = normalizeBaseUrl(nextBaseUrl);
    const endpoint = normalizedBaseUrl ? buildModelsUrl(normalizedBaseUrl) : '';

    if (!normalizedBaseUrl || !nextApiKey.trim()) {
      setResult({
        supportedFormats: [],
        formatResults: createEmptyFormatResults(),
        endpoint,
        error: '需要填写基础地址和 API 密钥。',
        statuses: [
          {
            label: '输入校验',
            state: 'failed',
            detail: '测试前请同时填写基础地址与 API 密钥。',
          },
        ],
        modelChecks: {},
      });
      return;
    }

    setBaseUrl(nextBaseUrl);
    setApiKey(nextApiKey);
    setIsLoading(true);
    setActiveHistoryId(options?.historyId ?? null);
    setActiveModelTest(null);
    setIsBatchTestingModels(false);
    setResult(null);

    try {
      const outcome = await detectModels(normalizedBaseUrl, nextApiKey, setResult);
      const finalResult: TestResult = {
        supportedFormats: outcome.supportedFormats,
        formatResults: outcome.formatResults,
        endpoint: outcome.endpoint,
        statuses: outcome.statuses,
        modelChecks: {},
      };

      setResult(finalResult);

      const nextHistory = saveHistoryEntry({
        id: `${Date.now()}`,
        baseUrl: normalizedBaseUrl,
        apiKey: nextApiKey.trim(),
        supportedFormats: outcome.supportedFormats,
        endpoint: outcome.endpoint,
        modelCount: outcome.supportedFormats.reduce(
          (count, format) => count + outcome.formatResults[format].models.length,
          0,
        ),
        createdAt: new Date().toISOString(),
      });
      setHistoryEntries(nextHistory);
    } catch (error) {
      setResult({
        supportedFormats: [],
        formatResults: createEmptyFormatResults(),
        endpoint,
        error: formatAxiosError(error),
        statuses: [
          {
            label: '执行失败',
            state: 'failed',
            detail: '测试流程在模型检测完成之前已中断。',
          },
        ],
        modelChecks: {},
      });
    } finally {
      setIsLoading(false);
      setActiveHistoryId(null);
    }
  };

  const handleModelTest = async (format: ApiFormat, model: string) => {
    if (!result || !result.supportedFormats.includes(format)) {
      return;
    }

    const modelCheckKey = buildModelCheckKey(format, model);
    setActiveModelTest(modelCheckKey);
    setResult((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        modelChecks: {
          ...current.modelChecks,
          [modelCheckKey]: {
            format,
            model,
            state: 'testing',
            detail: '正在调用真实推理接口验证模型可用性。',
          },
        },
      };
    });

    try {
      const detail = await probeModelAvailability(cleanBaseUrl, apiKey, format, model);

      setResult((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          modelChecks: {
            ...current.modelChecks,
            [modelCheckKey]: {
              format,
              model,
              state: 'success',
              detail,
              checkedAt: new Date().toISOString(),
            },
          },
        };
      });
    } catch (error) {
      setResult((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          modelChecks: {
            ...current.modelChecks,
            [modelCheckKey]: {
              format,
              model,
              state: 'failed',
              detail: formatAxiosError(error),
              checkedAt: new Date().toISOString(),
            },
          },
        };
      });
    } finally {
      setActiveModelTest(null);
    }
  };

  const handleTestAllModels = async (format: ApiFormat) => {
    if (!result || !result.supportedFormats.includes(format) || result.formatResults[format].models.length === 0) {
      return;
    }

    setIsBatchTestingModels(true);

    try {
      for (const model of result.formatResults[format].models) {
        const modelCheckKey = buildModelCheckKey(format, model);
        setActiveModelTest(modelCheckKey);
        setResult((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            modelChecks: {
              ...current.modelChecks,
              [modelCheckKey]: {
                format,
                model,
                state: 'testing',
                detail: '正在调用真实推理接口验证模型可用性。',
              },
            },
          };
        });

        try {
          const detail = await probeModelAvailability(cleanBaseUrl, apiKey, format, model);

          setResult((current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              modelChecks: {
                ...current.modelChecks,
                [modelCheckKey]: {
                  format,
                  model,
                  state: 'success',
                  detail,
                  checkedAt: new Date().toISOString(),
                },
              },
            };
          });
        } catch (error) {
          setResult((current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              modelChecks: {
                ...current.modelChecks,
                [modelCheckKey]: {
                  format,
                  model,
                  state: 'failed',
                  detail: formatAxiosError(error),
                  checkedAt: new Date().toISOString(),
                },
              },
            };
          });
        }
      }
    } finally {
      setActiveModelTest(null);
      setIsBatchTestingModels(false);
    }
  };

  const handleImportToCcSwitch = (format: ApiFormat) => {
    const importUrl = buildCcSwitchImportUrl(cleanBaseUrl, apiKey, format);
    window.location.href = importUrl;
  };

  const formatLabel =
    result?.supportedFormats.length === 2
      ? '兼容 OpenAI + Claude'
      : result?.supportedFormats[0]
        ? `兼容 ${getFormatLabel(result.supportedFormats[0])}`
        : '未确定';

  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">
            <Sparkles size={16} />
            API端点诊断
          </div>
          <h1>LLM API密钥检测器</h1>
          <p className="hero-lead">
            验证基础地址与 API 密钥，先读取端点支持的模型列表，再按需对单个模型发起真实推理请求，确认它是否可用。
          </p>

          <div className="hero-metrics">
            <article className="metric-card">
              <span>目标端点</span>
              <strong>{modelsEndpoint || '等待基础地址'}</strong>
            </article>
            <article className="metric-card">
              <span>后端代理策略</span>
              <strong>默认同源代理：`/__proxy`</strong>
            </article>
          </div>

          <div className="guidance-grid">
            <article className="guidance-card">
              <ShieldCheck size={18} />
              <div>
                <h2>同源代理转发</h2>
                <p>通过配套的 Node.js 后端服务转发请求，规避浏览器直接调用第三方接口时常见的 CORS 限制。</p>
              </div>
            </article>
            <article className="guidance-card">
              <Radar size={18} />
              <div>
                <h2>双阶段探测</h2>
                <p>先读取 `/v1/models` 识别接口类型与模型列表，再由你选择单个模型或一键逐个发起真实推理请求。</p>
              </div>
            </article>
            <article className="guidance-card">
              <History size={18} />
              <div>
                <h2>测试历史复用</h2>
                <p>成功读取过模型列表的端点会写入当前浏览器本地历史记录，点击即可自动回填并重新探测。</p>
              </div>
            </article>
          </div>
        </div>

        <section className="control-panel" aria-label="API检测表单">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">运行探测</p>
              <h2>连接设置</h2>
            </div>
            <span className="status-pill">
              <LockKeyhole size={14} />
              后端代理已启用
            </span>
          </div>

          <div className="field-group">
            <label htmlFor="baseUrl">基础地址</label>
            <div className="input-shell">
              <Globe size={18} />
              <input
                id="baseUrl"
                name="baseUrl"
                type="text"
                autoComplete="url"
                placeholder="https://api.openai.com"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <p className="field-note">请使用 API 根地址，应用会规范化为正确的 `/v1/models` 路径。</p>
          </div>

          <div className="field-group">
            <label htmlFor="apiKey">API密钥</label>
            <div className="input-shell">
              <KeyRound size={18} />
              <input
                id="apiKey"
                name="apiKey"
                type="text"
                autoComplete="off"
                placeholder="sk-..."
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            <p className="field-note">密钥会保存在当前浏览器本地，用于重复测试与历史记录回填。</p>
          </div>

          <button className="primary-button" onClick={() => void runTest()} disabled={!canSubmit}>
            {isLoading ? (
              <>
                <Loader2 size={18} className="spin" />
                正在测试端点
              </>
            ) : (
              <>
                <Sparkles size={18} />
                测试API密钥
              </>
            )}
          </button>

          <div className="endpoint-preview">
            <span>解析后的模型端点</span>
            <code>{modelsEndpoint || 'https://example.com/v1/models'}</code>
          </div>
        </section>
      </section>

      {historyEntries.length > 0 && (
        <section className="results-grid">
          <article className="results-panel history-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">测试历史</p>
                <h2>最近 {historyEntries.length} 次成功测试</h2>
              </div>
            </div>

            <div className="history-list">
              {historyEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="history-item"
                  onClick={() => void runTest({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, historyId: entry.id })}
                  disabled={isLoading}
                >
                  <div className="history-item-head">
                    <strong>{entry.baseUrl}</strong>
                    <span className="badge badge-success">
                      <RefreshCcw size={14} />
                      {activeHistoryId === entry.id ? '重新测试中' : '回填并测试'}
                    </span>
                  </div>
                  <p>
                    密钥 {maskApiKey(entry.apiKey)} · {(entry.supportedFormats ?? (entry.format ? [entry.format] : []))
                      .map(getFormatLabel)
                      .join(' + ') || '未知协议'} · {entry.modelCount} 个模型
                  </p>
                  <code>{entry.endpoint}</code>
                </button>
              ))}
            </div>
          </article>
        </section>
      )}

      {result && (
        <section className="results-grid">
          <article className="results-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">探测结果</p>
                <h2>{formatLabel}</h2>
              </div>
              <span className={`badge ${result.error ? 'badge-danger' : 'badge-success'}`}>
                {result.error ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                {result.error ? '需要关注' : '连接已验证'}
              </span>
            </div>

            <div className="summary-card">
              <span>已测试端点</span>
              <strong>{result.endpoint}</strong>
            </div>

            {result.error ? (
              <div className="message-box message-box-error">
                <AlertTriangle size={18} />
                <p>{result.error}</p>
              </div>
            ) : (
              <div className="message-box message-box-success">
                <CheckCircle2 size={18} />
                <p>端点返回了可识别的协议与模型列表。你现在可以按协议分别测试单个模型，或对该协议下一键逐个测试。</p>
              </div>
            )}
          </article>

          <article className="results-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">执行轨迹</p>
                <h2>过程详情</h2>
              </div>
            </div>

            <div className="status-list">
              {result.statuses.map((status) => (
                <div key={status.label} className={`status-item status-${status.state}`}>
                  <div className="status-icon">
                    {status.state === 'running' ? (
                      <Loader2 size={16} className="spin" />
                    ) : status.state === 'success' ? (
                      <CheckCircle2 size={16} />
                    ) : status.state === 'failed' ? (
                      <AlertTriangle size={16} />
                    ) : (
                      <span />
                    )}
                  </div>
                  <div>
                    <strong>{status.label}</strong>
                    <p>{status.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="results-panel models-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">模型可用性</p>
                <h2>{result.supportedFormats.length} 种已识别协议</h2>
              </div>
            </div>

            {result.supportedFormats.length > 0 ? (
              <div className={`format-section-list ${result.supportedFormats.length > 1 ? 'format-section-list-two-column' : ''}`}>
                {result.supportedFormats.map((format) => (
                  <section key={format} className="format-section">
                    <div className="format-section-head">
                      <div>
                        <p className="panel-kicker">{getFormatLabel(format)} 协议</p>
                        <h3>{result.formatResults[format].models.length} 个模型</h3>
                      </div>
                      <div className="format-section-toolbar">
                        <button
                          type="button"
                          className="secondary-button models-batch-button"
                          onClick={() => void handleTestAllModels(format)}
                          disabled={!canRunModelChecks}
                        >
                          {isBatchTestingModels ? (
                            <>
                              <Loader2 size={16} className="spin" />
                              正在逐个测试
                            </>
                          ) : (
                            <>
                              <Send size={16} />
                              测试全部
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          className="secondary-button models-batch-button"
                          onClick={() => handleImportToCcSwitch(format)}
                          disabled={!apiKey.trim()}
                        >
                          <SquareArrowOutUpRight size={16} />
                          导入 CC Switch
                        </button>
                      </div>
                    </div>

                    <div className="model-check-list">
                      {result.formatResults[format].models.map((model) => {
                        const modelCheckKey = buildModelCheckKey(format, model);
                        const check = result.modelChecks[modelCheckKey];
                        const isTesting = activeModelTest === modelCheckKey || check?.state === 'testing';

                        return (
                          <div key={modelCheckKey} className="model-check-item">
                            <div className="model-check-copy">
                              <strong>{model}</strong>
                              <p>
                                {check?.detail ?? `尚未验证该模型是否能通过 ${getFormatLabel(format)} 协议成功执行一次真实推理请求。`}
                              </p>
                            </div>

                            <div className="model-check-actions">
                              {check && check.state !== 'idle' && (
                                <span className={`badge ${check.state === 'success' ? 'badge-success' : check.state === 'failed' ? 'badge-danger' : ''}`}>
                                  {check.state === 'testing' ? (
                                    <Loader2 size={14} className="spin" />
                                  ) : check.state === 'success' ? (
                                    <CheckCircle2 size={14} />
                                  ) : (
                                    <AlertTriangle size={14} />
                                  )}
                                  {check.state === 'success' ? '模型可用' : check.state === 'failed' ? '模型不可用' : '测试中'}
                                </span>
                              )}

                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => void handleModelTest(format, model)}
                                disabled={!canRunModelChecks}
                              >
                                {isTesting ? (
                                  <>
                                    <Loader2 size={16} className="spin" />
                                    测试中
                                  </>
                                ) : (
                                  <>
                                    <Send size={16} />
                                    测试模型
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <p className="empty-state">未能从响应负载中提取到模型标识。</p>
            )}
          </article>
        </section>
      )}
    </>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<'llm' | 'brave'>('llm');

  return (
    <main className="app-shell">
      <div className="page-glow page-glow-left" />
      <div className="page-glow page-glow-right" />

      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', padding: '0 16px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setActiveTab('llm')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 24px',
            borderRadius: '12px',
            border: '1px solid var(--line)',
            background: activeTab === 'llm' ? 'var(--panel-strong)' : 'var(--panel)',
            color: activeTab === 'llm' ? 'var(--text)' : 'var(--text-muted)',
            fontWeight: activeTab === 'llm' ? 600 : 500,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <Server size={18} />
          LLM 接口检测
        </button>
        <button
          onClick={() => setActiveTab('brave')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 24px',
            borderRadius: '12px',
            border: '1px solid var(--line)',
            background: activeTab === 'brave' ? 'var(--panel-strong)' : 'var(--panel)',
            color: activeTab === 'brave' ? 'var(--text)' : 'var(--text-muted)',
            fontWeight: activeTab === 'brave' ? 600 : 500,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <Search size={18} />
          Brave Search 检测
        </button>
      </div>

      {activeTab === 'llm' ? <LLMChecker /> : <BraveChecker />}
    </main>
  );
}

export default App;
