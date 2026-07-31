import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/*
  Self-hosted variable fonts, imported here rather than from index.css so Vite
  resolves their url() references and emits the woff2 files -- see the note at
  the top of index.css for what happens otherwise.

  Not a CDN: the CSP is `default-src 'self'` with no font-src, so an external
  font URL is blocked outright. These load same-origin. Variable rather than
  static weights: one file per family covering 100-900, ~52 KB for the latin
  subset against ~159 KB for the four static weights this design uses.
*/
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'

import './index.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
