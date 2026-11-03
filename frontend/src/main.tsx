import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App.tsx'
import CookieNotice from './components/CookieNotice'
import { applyLook } from './lib/look'
import { reloadForNewBuild } from './lib/staleBuild'

applyLook()

window.addEventListener('vite:preloadError', (e) => { if (reloadForNewBuild()) e.preventDefault() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CookieNotice />
  </StrictMode>,
)
