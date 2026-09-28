import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import './index.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')

// The boundary wraps `App` rather than living inside it. A boundary cannot
// catch its own subtree's failure if the failure unmounts the boundary too —
// see `ErrorBoundary.tsx` for what that costs on a live floor.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
