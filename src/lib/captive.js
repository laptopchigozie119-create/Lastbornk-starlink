// POST credentials directly back to the router. link-login-only is supplied by
// RouterOS, and must be validated against the expected private gateway before use.
export function submitRouterLogin(loginUrl, username, password, destination = 'https://app.lastbornk.ng/?connected=1') {
  const url = new URL(loginUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid router login URL.')
  const form = document.createElement('form')
  form.method = 'POST'; form.action = url.toString(); form.style.display = 'none'
  const values = { username, password, dst: destination, popup: 'false' }
  Object.entries(values).forEach(([name, value]) => { const input=document.createElement('input'); input.name=name; input.value=value; form.appendChild(input) })
  document.body.appendChild(form); form.submit()
}
