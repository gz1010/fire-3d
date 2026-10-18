// Entry of the dev-only optional-sources page (extras-dev.html). Not a production build input.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/map-tokens.css'
import '../extras.css'
import './dev.css'
import { DevApp } from './DevApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
)
