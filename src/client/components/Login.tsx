import { useState } from 'react';

interface Props {
  apiUrl: string;
  onLogin: (player: { id: string; username: string; displayName: string; token: string }) => void;
}

export default function Login({ apiUrl, onLogin }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login'
        ? { username, password }
        : { username, password, displayName: displayName || username };

      const res = await fetch(`${apiUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.ok) {
        onLogin(data.data);
      } else {
        setError(data.error || 'Something went wrong');
      }
    } catch (err) {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <div className="w-full max-w-md">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-heading font-bold text-leather-dark tracking-wider mb-2">
            QUEST
          </h1>
          <p className="text-ink-faint font-body italic text-sm">
            An AI Dungeon Master awaits your party
          </p>
          <div className="mt-3 h-px bg-gradient-to-r from-transparent via-leather/30 to-transparent" />
        </div>

        {/* Form */}
        <div className="border border-leather/20 rounded-lg bg-parchment-light/50 p-8 shadow-lg">
          <div className="flex gap-4 mb-6">
            <button
              onClick={() => setMode('login')}
              className={`flex-1 pb-2 text-sm font-heading font-semibold tracking-wide border-b-2 transition-colors ${
                mode === 'login'
                  ? 'border-leather text-leather-dark'
                  : 'border-transparent text-ink-faint hover:text-ink-light'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setMode('register')}
              className={`flex-1 pb-2 text-sm font-heading font-semibold tracking-wide border-b-2 transition-colors ${
                mode === 'register'
                  ? 'border-leather text-leather-dark'
                  : 'border-transparent text-ink-faint hover:text-ink-light'
              }`}
            >
              New Adventurer
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="How shall we address thee?"
                  className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment font-body text-sm text-ink focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg border border-leather/20 bg-parchment font-body text-sm text-ink focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
              />
            </div>

            <div>
              <label className="block text-xs font-heading font-semibold text-ink-faint uppercase tracking-wider mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 pr-16 rounded-lg border border-leather/20 bg-parchment font-body text-sm text-ink focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-leather/60 hover:text-leather font-body transition-colors"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-blood font-body">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold text-sm tracking-wide hover:bg-leather-dark transition-colors disabled:opacity-50"
            >
              {loading ? 'Entering the realm...' : mode === 'login' ? 'Enter the Realm' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
