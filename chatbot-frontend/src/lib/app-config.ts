type AppConfig = Partial<{
  VITE_API_URL: string
  VITE_AWS_REGION: string
  VITE_COGNITO_USER_POOL_ID: string
  VITE_COGNITO_USER_POOL_CLIENT_ID: string
  VITE_PUBLIC_SIGNUP_ENABLED: string
  VITE_COGNITO_MFA: string
}>

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig
  }
}

const runtimeConfig = typeof window !== 'undefined' ? (window.__APP_CONFIG__ ?? {}) : {}

export function readAppConfig(key: keyof AppConfig): string | undefined {
  const runtimeValue = runtimeConfig[key]
  if (typeof runtimeValue === 'string' && runtimeValue.length > 0) {
    return runtimeValue
  }

  return import.meta.env[key]
}
