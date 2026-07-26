// Nigerian mobile numbers contain ten national digits after +234. The 091x
// range includes newer allocations such as Airtel 0912/0917 and MTN 0913/0916.
// We intentionally validate number format rather than infer the current carrier,
// because mobile number portability allows subscribers to change networks.
export const NIGERIAN_MOBILE_NATIONAL_PATTERN = /^(?:70[1-9]|80[2-9]|81[0-9]|90[1-9]|91[1-9])\d{7}$/

export function normalizeNigerianPhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  let national = digits

  if (national.startsWith('234')) national = national.slice(3)
  if (national.startsWith('0')) national = national.slice(1)

  if (!NIGERIAN_MOBILE_NATIONAL_PATTERN.test(national)) {
    throw new Error('Enter a valid Nigerian mobile number, for example +2349127520981 or 09127520981.')
  }

  return `+234${national}`
}
