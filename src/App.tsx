import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  KeyRound,
  Loader2,
  LockKeyhole,
  Network,
  Radar,
  ShieldCheck,
  Sparkles,
  Server,
  Search,
} from 'lucide-react';
import { BraveChecker } from './BraveChecker';

type ApiFormat = 'openai' | 'claude' | 'unknown' | null;

type ProbeStatus = {
  label: string;
  state: 'idle' | 'running' | 'success' | 'failed';
  detail: string;
};

type TestResult = {
  format: ApiFormat;
  models: string[];
  error?: string;
  endpoint: string;
  statuses: ProbeStatus[];
};

const STORAGE_KEY = 'llm-api-checker.form';
const DEFAULT_BASE_URL = 'https://api.openai.com';

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function buildModelsUrl(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
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

async function probeModels(
  targetUrl: string,
  headers: Record<string, string>,
) {
  const proxyUrl = import.meta.env.VITE_PROXY_URL || '/__proxy';
  const response = await axios.get(proxyUrl, {
    params: { url: targetUrl },
    headers,
    timeout: 15000,
  });

  return response.data;
}

function LLMChecker() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return;
    }

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

  const handleTest = async () => {
    if (!canSubmit) {
      setResult({
        format: 'unknown',
        models: [],
        endpoint: modelsEndpoint,
        error: '需要填写基础地址和 API 密钥。',
        statuses: [
          {
            label: '输入校验',
            state: 'failed',
            detail: '测试前请同时填写基础地址与 API 密钥。',
          },
        ],
      });
      return;
    }

    setIsLoading(true);
    setResult(null);

    const initialStatuses: ProbeStatus[] = [
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

    try {
      const openAiStatuses = [...initialStatuses];
      openAiStatuses[0] = { ...openAiStatuses[0], state: 'success' };
      openAiStatuses[1] = { ...openAiStatuses[1], state: 'running' };
      setResult({
        format: null,
        models: [],
        endpoint: modelsEndpoint,
        statuses: openAiStatuses,
      });

      try {
        const openAiData = await probeModels(modelsEndpoint, {
          Authorization: `Bearer ${apiKey.trim()}`,
        });
        const openAiModels = parseModelIds(openAiData);

        if (openAiModels.length > 0) {
          setResult({
            format: 'openai',
            models: openAiModels,
            endpoint: modelsEndpoint,
            statuses: [
              { ...openAiStatuses[0], state: 'success' },
              {
                ...openAiStatuses[1],
                state: 'success',
                detail: `从 OpenAI 兼容响应中检测到 ${openAiModels.length} 个模型。`,
              },
              {
                ...openAiStatuses[2],
                state: 'idle',
                detail: '已跳过，因为 OpenAI 兼容探测已成功。',
              },
            ],
          });
          return;
        }

        throw new Error('已收到响应，但未找到模型标识。');
      } catch (openAiError) {
        const openAiMessage = formatAxiosError(openAiError);
        const claudeStatuses = [
          { ...openAiStatuses[0], state: 'success' as const },
          {
            ...openAiStatuses[1],
            state: 'failed' as const,
            detail: openAiMessage,
          },
          { ...openAiStatuses[2], state: 'running' as const },
        ];

        setResult({
          format: null,
          models: [],
          endpoint: modelsEndpoint,
          statuses: claudeStatuses,
        });

        try {
          const claudeData = await probeModels(modelsEndpoint, {
            'x-api-key': apiKey.trim(),
            'anthropic-version': '2023-06-01',
          });
          const claudeModels = parseModelIds(claudeData);

          if (claudeModels.length > 0) {
            setResult({
              format: 'claude',
              models: claudeModels,
              endpoint: modelsEndpoint,
              statuses: [
                claudeStatuses[0],
                claudeStatuses[1],
                {
                  ...claudeStatuses[2],
                  state: 'success',
                  detail: `从 Claude 兼容响应中检测到 ${claudeModels.length} 个模型。`,
                },
              ],
            });
            return;
          }

          throw new Error('已收到响应，但未找到 Claude 兼容的模型标识。');
        } catch (claudeError) {
          const claudeMessage = formatAxiosError(claudeError);

          setResult({
            format: 'unknown',
            models: [],
            endpoint: modelsEndpoint,
            error:
              `端点有响应，但未匹配到 OpenAI 或 Claude 的模型发现。` +
              `OpenAI 探测：${openAiMessage} Claude 探测：${claudeMessage}`,
            statuses: [
              claudeStatuses[0],
              claudeStatuses[1],
              {
                ...claudeStatuses[2],
                state: 'failed',
                detail: claudeMessage,
              },
            ],
          });
        }
      }
    } catch (unexpectedError) {
      setResult({
        format: 'unknown',
        models: [],
        endpoint: modelsEndpoint,
        error: formatAxiosError(unexpectedError),
        statuses: [
          {
            label: '执行失败',
            state: 'failed',
            detail: '测试流程在模型检测完成之前已中断。',
          },
        ],
      });
    } finally {
      setIsLoading(false);
    }
  };

  const formatLabel =
    result?.format === 'openai'
      ? '兼容 OpenAI'
      : result?.format === 'claude'
        ? '兼容 Claude'
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
            验证基础地址，按常见的模型发现约定测试密钥，并通过配套后端代理解决浏览器跨域请求（CORS）问题。
          </p>

          <div className="hero-metrics">
            <article className="metric-card">
              <span>目标端点</span>
              <strong>{modelsEndpoint || '等待基础地址'}</strong>
            </article>
            <article className="metric-card">
              <span>后端代理策略</span>
              <strong>同源服务：`/__proxy`</strong>
            </article>
          </div>

          <div className="guidance-grid">
            <article className="guidance-card">
              <ShieldCheck size={18} />
              <div>
                <h2>更安全的跨域处理</h2>
                <p>通过部署配套的 Node.js 后端服务转发请求，避免了前端直接跨域调用导致的拦截与暴露。</p>
              </div>
            </article>
            <article className="guidance-card">
              <Radar size={18} />
              <div>
                <h2>双格式探测</h2>
                <p>测试器会同时以 Bearer 令牌和 Claude 风格请求头探测 `/v1/models`。</p>
              </div>
            </article>
            <article className="guidance-card">
              <Network size={18} />
              <div>
                <h2>开箱即用的部署</h2>
                <p>项目已包含完整的 Docker 配置，前端页面与代理服务可一键部署至生产环境。</p>
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
            <p className="field-note">密钥会在本地会话中保存，便于重复运行无需再次输入。</p>
          </div>

          <button className="primary-button" onClick={handleTest} disabled={!canSubmit}>
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
                <p>端点返回了可识别的模型列表，请在下方查看已发现的模型。</p>
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
                <p className="panel-kicker">已发现模型</p>
                <h2>{result.models.length} 个可用</h2>
              </div>
            </div>

            {result.models.length > 0 ? (
              <div className="model-grid">
                {result.models.map((model) => (
                  <span key={model} className="model-chip">
                    {model}
                  </span>
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
      
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', padding: '0 16px' }}>
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
            transition: 'all 0.2s ease'
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
            transition: 'all 0.2s ease'
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
