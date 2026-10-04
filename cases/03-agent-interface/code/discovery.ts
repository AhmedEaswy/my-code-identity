/**
 * Discovery documents.
 *
 * An agent that has only heard a site's name still needs to learn four things:
 * where the tool endpoint lives, what it exposes, how a human authorises the
 * delegation, and which host is the issuer. These builders emit the
 * machine-readable answers served from well-known paths, so the discovery
 * story is code rather than a wiki page that drifts.
 *
 * The site brokers credentials for its own API; the upstream identity provider
 * is only used for the human browser hop. Keeping those two ideas in separate
 * fields is what stops an agent from trying to complete a login on its own.
 */

export interface PlatformConfig {
  siteUrl: string
  backendBase: string
}

export interface DiscoveryUrls {
  siteUrl: string
  backendBase: string
  resource: string
  authDoc: string
  serverMetadata: string
  resourceMetadata: string
  toolEndpoint: string
  toolCard: string
  signInUrl: string
  exchangeUrl: string
  revocationUrl: string
}

export interface AgentAuthBlock {
  skill: string
  register_uri: string
  claim_uri: string
  revocation_uri: string
  identity_types_supported: string[]
  identity_assertion: {
    assertion_types_supported: string[]
    credential_types_supported: string[]
  }
  authorization_uri: string
  token_exchange_uri: string
  upstream_oidc_issuer: string
  tool_uri: string
  registration_note: string
}

export interface ServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  jwks_uri: string
  scopes_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
  service_documentation: string
  agent_auth: AgentAuthBlock
}

export interface ResourceMetadata {
  resource: string
  resource_name: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
  tool_endpoint: string
}

/** Scopes the resource host understands for the platform's own API. */
export const RESOURCE_SCOPES = [
  'read:articles',
  'read:guides',
  'read:courses',
  'read:bookmarks',
  'write:bookmarks',
] as const

const FALLBACK_SITE = 'https://meridian.example'
const FALLBACK_BACKEND = 'https://api.meridian.example'
const UPSTREAM_OIDC = 'https://idp.example'

export function resolveDiscoveryUrls(config: Partial<PlatformConfig> = {}): DiscoveryUrls {
  const siteUrl = (config.siteUrl || FALLBACK_SITE).replace(/\/+$/, '')
  const backendBase = (config.backendBase || FALLBACK_BACKEND).replace(/\/+$/, '')
  const signInUrl = `${siteUrl}/account/sign-in`
  const exchangeUrl = `${siteUrl}/api/session/exchange`

  return {
    siteUrl,
    backendBase,
    resource: `${siteUrl}/`,
    authDoc: `${siteUrl}/auth.md`,
    serverMetadata: `${siteUrl}/.well-known/oauth-authorization-server`,
    resourceMetadata: `${siteUrl}/.well-known/oauth-protected-resource`,
    toolEndpoint: `${siteUrl}/tools`,
    toolCard: `${siteUrl}/.well-known/tool-card.json`,
    signInUrl,
    exchangeUrl,
    revocationUrl: `${siteUrl}/api/session/revoke`,
  }
}

export function buildAgentAuthBlock(urls: DiscoveryUrls): AgentAuthBlock {
  return {
    skill: urls.authDoc,
    register_uri: urls.exchangeUrl,
    claim_uri: urls.signInUrl,
    revocation_uri: urls.revocationUrl,
    identity_types_supported: ['identity_assertion'],
    identity_assertion: {
      assertion_types_supported: ['verified_email'],
      credential_types_supported: ['access_token'],
    },
    authorization_uri: urls.signInUrl,
    token_exchange_uri: urls.exchangeUrl,
    upstream_oidc_issuer: UPSTREAM_OIDC,
    tool_uri: urls.toolEndpoint,
    // Honesty beats scanability here: automated assertion POSTs are not a
    // supported flow, and a scanner should read that rather than assume it.
    registration_note:
      'A human opens claim_uri and completes the upstream sign-in. Only then may a client POST register_uri (with the browser session cookie) to obtain a platform access token. Automated identity-assertion grants are not implemented.',
  }
}

export function buildServerMetadata(urls: DiscoveryUrls): ServerMetadata {
  return {
    issuer: urls.siteUrl,
    authorization_endpoint: `${UPSTREAM_OIDC}/authorize`,
    token_endpoint: `${UPSTREAM_OIDC}/token`,
    revocation_endpoint: `${UPSTREAM_OIDC}/revoke`,
    jwks_uri: `${UPSTREAM_OIDC}/.well-known/jwks.json`,
    scopes_supported: [...RESOURCE_SCOPES],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: urls.authDoc,
    agent_auth: buildAgentAuthBlock(urls),
  }
}

export function buildResourceMetadata(urls: DiscoveryUrls): ResourceMetadata {
  return {
    resource: urls.resource,
    resource_name: 'Meridian',
    // The site brokers its own credentials; the upstream provider is listed
    // only so the human hop is discoverable.
    authorization_servers: [urls.siteUrl, UPSTREAM_OIDC],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
    tool_endpoint: urls.toolEndpoint,
  }
}

/**
 * Link targets advertised on the auth document. GET and HEAD must return the
 * same set so a discovery probe that uses HEAD does not silently drop the
 * catalog and tool links.
 */
export function discoveryLinkHeader(urls: DiscoveryUrls): string {
  return [
    `<${urls.resourceMetadata}>; rel="protected-resource"; type="application/json"`,
    `<${urls.serverMetadata}>; rel="oauth-authorization-server"; type="application/json"`,
    `<${urls.toolCard}>; rel="tool-card"; type="application/json"`,
    `<${urls.toolEndpoint}>; rel="tools"; type="application/json"`,
  ].join(', ')
}

export function setDiscoveryHeaders(setHeaderFn: (name: string, value: string) => void): void {
  setHeaderFn('Content-Type', 'application/json; charset=utf-8')
  setHeaderFn('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
}
