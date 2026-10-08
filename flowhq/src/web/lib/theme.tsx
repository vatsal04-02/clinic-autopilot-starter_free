import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
type Theme = 'dark' | 'light';
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} });
const read = (): Theme => { try { return localStorage.getItem('fhq-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('fhq-theme', theme); } catch { /* private mode */ } }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
