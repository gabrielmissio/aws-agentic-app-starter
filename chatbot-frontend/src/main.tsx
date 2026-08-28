import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.tsx'
import { I18nProvider } from './lib/i18n/index.tsx'
import { configureAuth } from './lib/auth.ts'
import { trackKeyboardInset } from './lib/viewport.ts'
import './styles.css'

// Initialize Cognito (no-op if env vars are missing)
configureAuth()

// Lives for the life of the tab, so the teardown is deliberately dropped.
trackKeyboardInset()

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        {/* Real paths rather than hashes: CloudFront already serves index.html for any unmatched
            route (see the SPA fallback in infra/src/stacks/frontend-stack.ts), so a deep link to a
            checkout's proof works when it is pasted or bookmarked. */}
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </I18nProvider>
    </StrictMode>,
  )
}
