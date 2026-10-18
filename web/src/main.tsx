import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/layout.css'
import './styles/controls.css'
import './styles/header.css'
import './styles/panel.css'
import './styles/dock.css'
import './styles/overlays.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
