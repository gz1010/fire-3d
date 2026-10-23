// Entry of the dev-only optional-sources page (extras-dev.html). Not a production build input.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/map-tokens.css'
import '../extras.css'
import './dev.css'
import { DevApp } from './DevApp'
import { US_OFFICIAL_PRESET_ID } from './presets'
import { UsOfficialPreset } from './UsOfficialPreset'
import { seedUsOfficialStores } from './usOfficialSeed'

const usOfficial = new URLSearchParams(window.location.search).get('preset') === US_OFFICIAL_PRESET_ID
if (usOfficial) seedUsOfficialStores()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {usOfficial ? <UsOfficialPreset /> : <DevApp />}
  </StrictMode>,
)
