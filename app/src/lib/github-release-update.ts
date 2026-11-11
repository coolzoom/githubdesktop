import { gt, rcompare, valid } from 'semver'

/** owner/name of the GitHub repository whose Releases are update feeds. */
export const defaultUpdateRepository = 'coolzoom/githubdesktop'

const releaseShaPattern = /Desktop-Update-Sha:\s*([0-9a-f]{40})/i

export interface IGitHubReleaseAsset {
  readonly name: string
  readonly browser_download_url: string
}

export interface IGitHubReleaseListing {
  readonly tag_name: string
  readonly html_url: string
  readonly body?: string | null
  readonly draft?: boolean
  readonly assets?: ReadonlyArray<IGitHubReleaseAsset>
}

export interface IAvailableGitHubUpdate {
  readonly version: string
  readonly htmlUrl: string
  readonly assetUrl: string | null
  readonly sha: string | null
}

export type UpdatePlatform = 'darwin' | 'win32' | 'linux'

export function parseReleaseVersion(tagName: string): string | null {
  return valid(tagName.trim().replace(/^v/i, ''))
}

/** Reads the commit marker written into GitHub Release notes by CI. */
export function readReleaseSha(body: string | null | undefined): string | null {
  if (body == null || body.length === 0) {
    return null
  }

  const match = releaseShaPattern.exec(body)
  return match?.[1]?.toLowerCase() ?? null
}

export function selectReleaseAsset(
  assets: ReadonlyArray<IGitHubReleaseAsset>,
  platform: 'darwin' | 'win32',
  arch: string
): IGitHubReleaseAsset | null {
  const normalizedArch = arch === 'arm64' ? 'arm64' : 'x64'
  const matches = assets.filter(asset =>
    assetMatchesPlatform(asset.name, platform, normalizedArch)
  )

  if (matches.length === 0) {
    return null
  }

  const preferredSuffix =
    platform === 'darwin'
      ? `-${normalizedArch}.zip`
      : `setup-${normalizedArch}.exe`

  return (
    matches.find(asset => asset.name.toLowerCase().endsWith(preferredSuffix)) ??
    matches[0]
  )
}

/**
 * Picks the highest semver Release that is newer than the running app.
 * The same commit as the Release is not an update, so local dev builds of
 * the commit that was just published stay quiet.
 */
export function selectNewerRelease(
  releases: ReadonlyArray<IGitHubReleaseListing>,
  currentVersion: string,
  currentSha: string,
  platform: UpdatePlatform,
  arch: string
): IAvailableGitHubUpdate | null {
  if (platform === 'linux' || valid(currentVersion) === null) {
    return null
  }

  const candidates = releases
    .filter(release => release.draft !== true)
    .flatMap(release => {
      const version = parseReleaseVersion(release.tag_name)
      return version === null ? [] : [{ release, version }]
    })
    .sort((left, right) => rcompare(left.version, right.version))

  const latest = candidates[0]
  if (latest === undefined || !gt(latest.version, currentVersion)) {
    return null
  }

  const sha = readReleaseSha(latest.release.body)
  if (sha !== null && sha === currentSha.toLowerCase()) {
    return null
  }

  const asset = selectReleaseAsset(readAssets(latest.release), platform, arch)

  return {
    version: latest.version,
    htmlUrl: latest.release.html_url,
    assetUrl: asset?.browser_download_url ?? null,
    sha,
  }
}

export async function fetchNewerGitHubRelease(args: {
  repository: string
  currentVersion: string
  currentSha: string
  platform: UpdatePlatform
  arch: string
  userAgent: string
}): Promise<IAvailableGitHubUpdate | null> {
  if (args.platform === 'linux' || args.repository.length === 0) {
    return null
  }

  const response = await fetch(
    `https://api.github.com/repos/${args.repository}/releases?per_page=20`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': args.userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `Failed to check GitHub releases for ${args.repository} (${response.status})`
    )
  }

  const body: unknown = await response.json()
  if (!Array.isArray(body)) {
    return null
  }

  return selectNewerRelease(
    body.filter(isGitHubReleaseListing),
    args.currentVersion,
    args.currentSha,
    args.platform,
    args.arch
  )
}

function assetMatchesPlatform(
  name: string,
  platform: 'darwin' | 'win32',
  arch: string
): boolean {
  const normalized = name.toLowerCase()
  if (!normalized.includes(arch)) {
    return false
  }

  if (platform === 'darwin') {
    return normalized.endsWith('.zip')
  }

  return normalized.endsWith('.exe') && normalized.includes('setup')
}

function readAssets(
  release: IGitHubReleaseListing
): ReadonlyArray<IGitHubReleaseAsset> {
  if (!Array.isArray(release.assets)) {
    return []
  }

  return release.assets.filter(isGitHubReleaseAsset)
}

function isGitHubReleaseAsset(value: unknown): value is IGitHubReleaseAsset {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const asset = value as Partial<IGitHubReleaseAsset>
  return (
    typeof asset.name === 'string' &&
    typeof asset.browser_download_url === 'string'
  )
}

function isGitHubReleaseListing(
  value: unknown
): value is IGitHubReleaseListing {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const release = value as Partial<IGitHubReleaseListing>
  return (
    typeof release.tag_name === 'string' && typeof release.html_url === 'string'
  )
}
