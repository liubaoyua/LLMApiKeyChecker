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
} from 'lucide-react';

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
  const response = await axios.get('/__proxy', {
    params: { url: targetUrl },
    headers,
    timeout: 15000,
  });

  return response.data;
}

function App() {
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
        error: 'Base URL and API Key are required.',
        statuses: [
          {
            label: 'Input validation',
            state: 'failed',
            detail: 'Fill in both the base URL and the API key before testing.',
          },
        ],
      });
      return;
    }

    setIsLoading(true);
    setResult(null);

    const initialStatuses: ProbeStatus[] = [
      {
        label: 'Route request through local proxy',
        state: 'running',
        detail: 'Avoiding browser-side CORS by sending the request through Vite dev server.',
      },
      {
        label: 'Probe OpenAI-compatible models endpoint',
        state: 'idle',
        detail: 'Checking Authorization bearer flow and `/v1/models` response shape.',
      },
      {
        label: 'Probe Claude-compatible models endpoint',
        state: 'idle',
        detail: 'Checking `x-api-key` + `anthropic-version` headers against the same endpoint.',
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
                detail: `Detected ${openAiModels.length} models from an OpenAI-compatible response.`,
              },
              {
                ...openAiStatuses[2],
                state: 'idle',
                detail: 'Skipped because the OpenAI-compatible probe already succeeded.',
              },
            ],
          });
          return;
        }

        throw new Error('Received a response, but no model identifiers were found.');
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
                  detail: `Detected ${claudeModels.length} models from a Claude-compatible response.`,
                },
              ],
            });
            return;
          }

          throw new Error('Received a response, but no Claude-compatible model identifiers were found.');
        } catch (claudeError) {
          const claudeMessage = formatAxiosError(claudeError);

          setResult({
            format: 'unknown',
            models: [],
            endpoint: modelsEndpoint,
            error:
              `The endpoint responded, but neither OpenAI nor Claude model discovery matched. ` +
              `OpenAI probe: ${openAiMessage} Claude probe: ${claudeMessage}`,
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
            label: 'Execution failure',
            state: 'failed',
            detail: 'The test flow stopped before model detection completed.',
          },
        ],
      });
    } finally {
      setIsLoading(false);
    }
  };

  const formatLabel =
    result?.format === 'openai'
      ? 'OpenAI-compatible'
      : result?.format === 'claude'
        ? 'Claude-compatible'
        : 'Undetermined';

  return (
    <main className="app-shell">
      <div className="page-glow page-glow-left" />
      <div className="page-glow page-glow-right" />

      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">
            <Sparkles size={16} />
            API endpoint diagnostics
          </div>
          <h1>LLM API Key Checker</h1>
          <p className="hero-lead">
            Validate a base URL, test the key against common model-discovery conventions, and avoid
            browser-side CORS during local development.
          </p>

          <div className="hero-metrics">
            <article className="metric-card">
              <span>Target endpoint</span>
              <strong>{modelsEndpoint || 'Waiting for a base URL'}</strong>
            </article>
            <article className="metric-card">
              <span>Browser CORS strategy</span>
              <strong>Local proxy on `/__proxy`</strong>
            </article>
          </div>

          <div className="guidance-grid">
            <article className="guidance-card">
              <ShieldCheck size={18} />
              <div>
                <h2>Safer key handling</h2>
                <p>Requests are relayed through the local Vite server instead of exposing a cross-origin browser call.</p>
              </div>
            </article>
            <article className="guidance-card">
              <Radar size={18} />
              <div>
                <h2>Dual format probe</h2>
                <p>The tester checks both bearer-token and Claude-style headers against `/v1/models`.</p>
              </div>
            </article>
            <article className="guidance-card">
              <Network size={18} />
              <div>
                <h2>Production note</h2>
                <p>A deployed static site still needs a real backend relay or upstream CORS support from the API provider.</p>
              </div>
            </article>
          </div>
        </div>

        <section className="control-panel" aria-label="API checker form">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Run a probe</p>
              <h2>Connection setup</h2>
            </div>
            <span className="status-pill">
              <LockKeyhole size={14} />
              Dev proxy enabled
            </span>
          </div>

          <div className="field-group">
            <label htmlFor="baseUrl">Base URL</label>
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
            <p className="field-note">Use the API root. The app will normalize it to the correct `/v1/models` path.</p>
          </div>

          <div className="field-group">
            <label htmlFor="apiKey">API Key</label>
            <div className="input-shell">
              <KeyRound size={18} />
              <input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            <p className="field-note">The key is stored locally in this browser session so you can rerun checks without retyping.</p>
          </div>

          <button className="primary-button" onClick={handleTest} disabled={!canSubmit}>
            {isLoading ? (
              <>
                <Loader2 size={18} className="spin" />
                Testing endpoint
              </>
            ) : (
              <>
                <Sparkles size={18} />
                Test API key
              </>
            )}
          </button>

          <div className="endpoint-preview">
            <span>Resolved models endpoint</span>
            <code>{modelsEndpoint || 'https://example.com/v1/models'}</code>
          </div>
        </section>
      </section>

      {result && (
        <section className="results-grid">
          <article className="results-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Probe result</p>
                <h2>{formatLabel}</h2>
              </div>
              <span className={`badge ${result.error ? 'badge-danger' : 'badge-success'}`}>
                {result.error ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                {result.error ? 'Attention needed' : 'Connection verified'}
              </span>
            </div>

            <div className="summary-card">
              <span>Endpoint tested</span>
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
                <p>The endpoint returned a recognizable model list. Review the discovered models below.</p>
              </div>
            )}
          </article>

          <article className="results-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Execution trace</p>
                <h2>What happened</h2>
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
                <p className="panel-kicker">Discovered models</p>
                <h2>{result.models.length} available</h2>
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
              <p className="empty-state">No model identifiers were extracted from the response payload.</p>
            )}
          </article>
        </section>
      )}
    </main>
  );
}

export default App;
