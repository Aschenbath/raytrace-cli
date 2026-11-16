// Shared box identity, matching the website's light and dark palettes.
export function BrandLogo() {
  return <svg className="rt-brand-cube" viewBox="0 0 42 44" aria-hidden="true">
    <path className="rt-brand-cube-top" d="M21 2 39 12.5 21 23 3 12.5Z"/>
    <path className="rt-brand-cube-left" d="M3 12.5 21 23V42L3 31.5Z"/>
    <path className="rt-brand-cube-right" d="M21 23 39 12.5V31.5L21 42Z"/>
    <g className="rt-brand-cube-marks">
      <g transform="matrix(.68 .395 -.68 .395 21 3)"><path d="m10.586 5.414-5.172 5.172m13.172 2.828-5.172 5.172M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/></g>
      <g transform="matrix(.68 .395 0 .71 4 13.5)"><path d="m10.586 5.414-5.172 5.172m13.172 2.828-5.172 5.172M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/></g>
      <g transform="matrix(.68 -.395 0 .71 22 23)"><path d="m10.586 5.414-5.172 5.172m13.172 2.828-5.172 5.172M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/></g>
    </g>
  </svg>;
}
