import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  parseReleaseVersion,
  readReleaseSha,
  selectNewerRelease,
  selectReleaseAsset,
  type IGitHubReleaseListing,
} from '../../src/lib/github-release-update'

const currentSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const newerSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function release(
  tag: string,
  sha: string | null,
  assets: ReadonlyArray<{ name: string; browser_download_url: string }> = []
): IGitHubReleaseListing {
  return {
    tag_name: tag,
    html_url: `https://github.com/coolzoom/githubdesktop/releases/tag/${tag}`,
    body: sha === null ? 'notes' : `Desktop-Update-Sha: ${sha}`,
    assets,
  }
}

const assets = [
  {
    name: 'GitHub Desktop-arm64.zip',
    browser_download_url: 'https://example.com/mac-arm64.zip',
  },
  {
    name: 'GitHub Desktop-x64.zip',
    browser_download_url: 'https://example.com/mac-x64.zip',
  },
  {
    name: 'GitHubDesktopSetup-arm64.exe',
    browser_download_url: 'https://example.com/win-arm64.exe',
  },
  {
    name: 'GitHubDesktopSetup-x64.exe',
    browser_download_url: 'https://example.com/win-x64.exe',
  },
]

describe('github release updates', () => {
  it('parses a v-prefixed release tag', () => {
    assert.equal(parseReleaseVersion('v3.6.8-beta3.42'), '3.6.8-beta3.42')
  })

  it('reads the commit marker from release notes', () => {
    assert.equal(
      readReleaseSha('hello\nDesktop-Update-Sha: ' + newerSha + '\n'),
      newerSha
    )
  })

  it('selects the installer for the running platform', () => {
    assert.equal(
      selectReleaseAsset(assets, 'darwin', 'arm64')?.browser_download_url,
      'https://example.com/mac-arm64.zip'
    )
    assert.equal(
      selectReleaseAsset(assets, 'win32', 'x64')?.browser_download_url,
      'https://example.com/win-x64.exe'
    )
  })

  it('reports a release newer than the running version', () => {
    const update = selectNewerRelease(
      [release('v3.6.8-beta3.2', newerSha, assets)],
      '3.6.8-beta3',
      currentSha,
      'darwin',
      'arm64'
    )

    assert.equal(update?.version, '3.6.8-beta3.2')
    assert.equal(update?.assetUrl, 'https://example.com/mac-arm64.zip')
  })

  it('ignores a release built from the commit that is already running', () => {
    const update = selectNewerRelease(
      [release('v3.6.8-beta3.2', currentSha, assets)],
      '3.6.8-beta3',
      currentSha,
      'win32',
      'x64'
    )

    assert.equal(update, null)
  })

  it('ignores releases that are not newer', () => {
    const update = selectNewerRelease(
      [
        release('v3.6.8-beta3.2', newerSha, assets),
        release('v3.6.8-beta3.9', newerSha, assets),
      ],
      '3.6.8-beta3.9',
      currentSha,
      'win32',
      'x64'
    )

    assert.equal(update, null)
  })

  it('chooses the highest semver when several releases exist', () => {
    const update = selectNewerRelease(
      [
        release('v3.6.8-beta3.2', newerSha, assets),
        release('v3.6.8-beta3.10', newerSha, assets),
      ],
      '3.6.8-beta3',
      currentSha,
      'win32',
      'arm64'
    )

    assert.equal(update?.version, '3.6.8-beta3.10')
    assert.equal(update?.assetUrl, 'https://example.com/win-arm64.exe')
  })

  it('does not offer Linux updates', () => {
    const update = selectNewerRelease(
      [release('v3.6.8-beta3.2', newerSha, assets)],
      '3.6.8-beta3',
      currentSha,
      'linux',
      'x64'
    )

    assert.equal(update, null)
  })
})
