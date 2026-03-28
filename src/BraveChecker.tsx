import { useState } from 'react';
import axios from 'axios';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Search,
} from 'lucide-react';

interface BraveKeyResult {
  key: string;
  status: 'idle' | 'testing' | 'valid' | 'invalid';
  limit?: string;
  remaining?: string;
  error?: string;
}

export function BraveChecker() {
  const [keysInput, setKeysInput] = useState('');
  const [results, setResults] = useState<BraveKeyResult[]>([]);
  const [isTesting, setIsTesting] = useState(false);

  const handleTest = async () => {
    const rawKeys = keysInput.split('\n').map((k) => k.trim()).filter(Boolean);
    if (rawKeys.length === 0) return;

    setIsTesting(true);
    
    // Initialize results
    const initialResults: BraveKeyResult[] = rawKeys.map((key) => ({
      key,
      status: 'testing',
    }));
    setResults(initialResults);

    // Test keys sequentially to avoid hammering the proxy/network too much at once
    const updatedResults = [...initialResults];
    for (let i = 0; i < rawKeys.length; i++) {
      const currentKey = rawKeys[i];
      try {
        const proxyUrl = import.meta.env.VITE_PROXY_URL || '/__proxy';
        const targetUrl = 'https://api.search.brave.com/res/v1/web/search?q=test';
        
        const response = await axios.get(proxyUrl, {
          params: { url: targetUrl },
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': currentKey,
          },
          timeout: 10000,
        });

        updatedResults[i] = {
          key: currentKey,
          status: 'valid',
          limit: response.headers['x-ratelimit-limit'] || response.headers['x-ratelimit-request-limit'] || 'Unknown',
          remaining: response.headers['x-ratelimit-remaining'] || response.headers['x-ratelimit-request-remaining'] || 'Unknown',
        };
      } catch (error: unknown) {
        let errorMsg = 'Failed';
        if (axios.isAxiosError(error) && error.response) {
          if (error.response.status === 401 || error.response.status === 403) {
            errorMsg = 'Invalid Key';
          } else if (error.response.status === 429) {
            errorMsg = 'Rate Limited';
          } else {
            errorMsg = `HTTP ${error.response.status}`;
          }
        }
        updatedResults[i] = {
          key: currentKey,
          status: 'invalid',
          error: errorMsg,
        };
      }
      // Update state after each key so UI reflects progress
      setResults([...updatedResults]);
    }

    setIsTesting(false);
  };

  return (
    <section className="hero-panel" style={{ marginTop: '24px' }}>
      <div className="hero-copy">
        <div className="eyebrow">
          <Search size={16} />
          Brave Search API 检测
        </div>
        <h1>批量检测 Brave Search API 密钥</h1>
        <p className="hero-lead">
          输入一个或多个 Brave Search API Key，自动调用搜索接口验证其有效性，并尝试获取剩余请求次数。
        </p>

        <div className="guidance-grid">
          <article className="guidance-card">
            <Search size={18} />
            <div>
              <h2>搜索接口测试</h2>
              <p>向 `/res/v1/web/search` 发送测试查询来验证密钥真实可用性。</p>
            </div>
          </article>
          <article className="guidance-card">
            <CheckCircle2 size={18} />
            <div>
              <h2>限流状态解析</h2>
              <p>读取响应中的 `X-RateLimit-*` 标头以展示剩余额度（如果支持）。</p>
            </div>
          </article>
        </div>
      </div>

      <section className="control-panel" aria-label="Brave API检测表单">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">批量输入</p>
            <h2>API 密钥列表</h2>
          </div>
        </div>

        <div className="field-group">
          <label htmlFor="braveKeys">密钥 (每行一个)</label>
          <div className="input-shell" style={{ height: 'auto', padding: '0' }}>
            <textarea
              id="braveKeys"
              rows={5}
              placeholder="BSAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&#10;BSAyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
              value={keysInput}
              onChange={(e) => setKeysInput(e.target.value)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                padding: '12px 16px',
                resize: 'vertical',
                outline: 'none',
                minHeight: '120px',
                fontFamily: 'monospace'
              }}
            />
          </div>
          <p className="field-note">输入你的 Brave Search API 密钥，每行一个。</p>
        </div>

        <button
          className="primary-button"
          onClick={handleTest}
          disabled={isTesting || !keysInput.trim()}
        >
          {isTesting ? (
            <>
              <Loader2 size={18} className="spin" />
              正在测试...
            </>
          ) : (
            <>
              <Sparkles size={18} />
              开始检测
            </>
          )}
        </button>
      </section>

      {results.length > 0 && (
        <section className="results-grid" style={{ gridColumn: '1 / -1', marginTop: '24px' }}>
          <article className="results-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">检测结果</p>
                <h2>共 {results.length} 个密钥</h2>
              </div>
            </div>

            <div className="status-list" style={{ marginTop: '16px' }}>
              {results.map((r, idx) => (
                <div
                  key={idx}
                  className={`status-item ${
                    r.status === 'testing' ? 'status-running' : r.status === 'valid' ? 'status-success' : 'status-failed'
                  }`}
                >
                  <div className="status-icon">
                    {r.status === 'testing' ? (
                      <Loader2 size={16} className="spin" />
                    ) : r.status === 'valid' ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <AlertTriangle size={16} />
                    )}
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <strong style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.key}</strong>
                      <p>
                        {r.status === 'testing' && '正在验证...'}
                        {r.status === 'invalid' && <span style={{ color: 'var(--warn)' }}>{r.error}</span>}
                        {r.status === 'valid' && (
                          <span style={{ color: 'var(--ok)' }}>
                            有效 | 剩余请求: {r.remaining} / {r.limit}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}
    </section>
  );
}
