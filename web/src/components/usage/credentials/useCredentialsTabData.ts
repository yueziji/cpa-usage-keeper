import { useEffect, useMemo } from 'react'
import {
  applyUsageIdentityClientSort,
  buildAiProviderCredentialRows,
  buildAuthFileCredentialRows,
  paginateCredentials,
  selectQuotaEligibleAuthIndexes,
  type AiProviderCredentialRow,
  type AuthFileCredentialRow,
} from './credentialViewModels'
import { matchesCredentialProviderFilter, type CredentialProviderFilterKey } from './credentialProviderFilters'
import { useCredentialPages } from './useCredentialPages'
import { useQuotaCache } from './useQuotaCache'
import type { UsageIdentityPageSort } from '@/lib/api'
import type { UsageIdentity } from '@/lib/types'
import { quotaRefreshDisplayError, useQuotaRefreshTasks } from './useQuotaRefreshTasks'

interface UseCredentialsTabDataOptions {
  enabled: boolean
  onAuthRequired?: () => void
  providerFilter?: CredentialProviderFilterKey
}

export interface CredentialsTabData {
  authFileRows: AuthFileCredentialRow[]
  aiProviderRows: AiProviderCredentialRow[]
  allIdentitiesForFilter: UsageIdentity[]
  authFileTotal: number
  aiProviderTotal: number
  authFilePageSize: number
  aiProviderPageSize: number
  authFilePage: number
  aiProviderPage: number
  authFileTotalPages: number
  aiProviderTotalPages: number
  authFileActiveOnly: boolean
  authFileSort: UsageIdentityPageSort
  aiProviderSort: UsageIdentityPageSort
  setAuthFilePage: (page: number) => void
  setAiProviderPage: (page: number) => void
  setAuthFilePageSize: (pageSize: number) => void
  setAiProviderPageSize: (pageSize: number) => void
  setAuthFileActiveOnly: (activeOnly: boolean) => void
  setAuthFileSort: (sort: UsageIdentityPageSort) => void
  setAiProviderSort: (sort: UsageIdentityPageSort) => void
  loading: boolean
  error: string
  quotaRefreshing: boolean
  quotaRefreshError: string
  refresh: () => Promise<void>
  refreshQuotaForCurrentAuthFilePage: () => Promise<void>
  refreshQuotaForAuthIndex: (authIndex: string) => Promise<void>
}

export function useCredentialsTabData({ enabled, onAuthRequired, providerFilter = 'all' }: UseCredentialsTabDataOptions): CredentialsTabData {
  // 页面 hook 只编排分页、缓存和刷新任务三层数据，不直接发散 API 调用。
  const credentialPages = useCredentialPages({ enabled, onAuthRequired, providerFilter })
  const isProviderFiltered = providerFilter !== 'all'

  // 过滤激活时切到客户端分页：从 allIdentitiesForFilter 取全量，按 auth_type / activeOnly / provider 过滤后再排序分页，
  // 避免「服务端分页 + 客户端过滤」导致的页数和每页条目数错乱。
  const clientAuthFilesPage = useMemo(() => {
    if (!isProviderFiltered) return null
    const filtered = credentialPages.allIdentitiesForFilter
      .filter((identity) => identity.auth_type === 1)
      .filter((identity) => !credentialPages.authFileActiveOnly || !identity.disabled)
      .filter((identity) => matchesCredentialProviderFilter({ identity }, providerFilter))
    const sorted = applyUsageIdentityClientSort(filtered, credentialPages.authFileSort)
    return paginateCredentials(sorted, credentialPages.authFilePage, credentialPages.authFilePageSize)
  }, [
    isProviderFiltered,
    credentialPages.allIdentitiesForFilter,
    credentialPages.authFileActiveOnly,
    credentialPages.authFileSort,
    credentialPages.authFilePage,
    credentialPages.authFilePageSize,
    providerFilter,
  ])

  const clientAiProvidersPage = useMemo(() => {
    if (!isProviderFiltered) return null
    const filtered = credentialPages.allIdentitiesForFilter
      .filter((identity) => identity.auth_type === 2)
      .filter((identity) => matchesCredentialProviderFilter({ identity }, providerFilter))
    const sorted = applyUsageIdentityClientSort(filtered, credentialPages.aiProviderSort)
    return paginateCredentials(sorted, credentialPages.aiProviderPage, credentialPages.aiProviderPageSize)
  }, [
    isProviderFiltered,
    credentialPages.allIdentitiesForFilter,
    credentialPages.aiProviderSort,
    credentialPages.aiProviderPage,
    credentialPages.aiProviderPageSize,
    providerFilter,
  ])

  // 过滤后页码超出范围时把状态收敛到客户端裁剪后的页码，避免分页器停在不存在的页。
  useEffect(() => {
    if (clientAuthFilesPage && clientAuthFilesPage.page !== credentialPages.authFilePage) {
      credentialPages.setAuthFilePage(clientAuthFilesPage.page)
    }
  }, [clientAuthFilesPage, credentialPages.authFilePage, credentialPages.setAuthFilePage])

  useEffect(() => {
    if (clientAiProvidersPage && clientAiProvidersPage.page !== credentialPages.aiProviderPage) {
      credentialPages.setAiProviderPage(clientAiProvidersPage.page)
    }
  }, [clientAiProvidersPage, credentialPages.aiProviderPage, credentialPages.setAiProviderPage])

  // 当前可见身份：过滤激活用客户端分页结果，否则用服务端分页结果。quota 缓存跟着可见身份走，保证过滤后也能看到限额。
  const currentAuthFileIdentities = clientAuthFilesPage?.items ?? credentialPages.authFileIdentities
  const currentAiProviderIdentities = clientAiProvidersPage?.items ?? credentialPages.aiProviderIdentities

  const currentAuthIndexes = useMemo(
    () => selectQuotaEligibleAuthIndexes(currentAuthFileIdentities),
    [currentAuthFileIdentities],
  )
  const { quotaByAuthIndex, cachedQuotaStateByAuthIndex, setQuotaByAuthIndex } = useQuotaCache({
    enabled,
    authIndexes: currentAuthIndexes,
    onAuthRequired,
  })
  const quotaRefreshTasks = useQuotaRefreshTasks({
    enabled,
    currentAuthIndexes,
    setQuotaByAuthIndex,
    onAuthRequired,
  })

  // 把对象状态转成 Map 后交给纯 view model，组件层只消费已组合好的行数据。
  const quotaRowsByAuthIndex = useMemo(() => new Map(Object.entries(quotaByAuthIndex)), [quotaByAuthIndex])
  const quotaStates = useMemo(() => {
    const mergedStates = { ...cachedQuotaStateByAuthIndex, ...quotaRefreshTasks.quotaStateByAuthIndex }
    return new Map(Object.entries(mergedStates).map(([authIndex, state]) => [authIndex, {
      quotaLoading: state.loading ?? false,
      quotaError: state.error,
      refreshStatus: state.refreshStatus,
    }]))
  }, [cachedQuotaStateByAuthIndex, quotaRefreshTasks.quotaStateByAuthIndex])

  const authFileRows = useMemo(
    () => buildAuthFileCredentialRows(currentAuthFileIdentities, quotaRowsByAuthIndex, quotaStates),
    [currentAuthFileIdentities, quotaRowsByAuthIndex, quotaStates],
  )
  const aiProviderRows = useMemo(
    () => buildAiProviderCredentialRows(currentAiProviderIdentities),
    [currentAiProviderIdentities],
  )

  return {
    authFileRows,
    aiProviderRows,
    allIdentitiesForFilter: credentialPages.allIdentitiesForFilter,
    authFileTotal: clientAuthFilesPage?.total ?? credentialPages.authFileTotal,
    aiProviderTotal: clientAiProvidersPage?.total ?? credentialPages.aiProviderTotal,
    authFilePageSize: credentialPages.authFilePageSize,
    aiProviderPageSize: credentialPages.aiProviderPageSize,
    authFilePage: clientAuthFilesPage?.page ?? credentialPages.authFilePage,
    aiProviderPage: clientAiProvidersPage?.page ?? credentialPages.aiProviderPage,
    authFileTotalPages: clientAuthFilesPage?.totalPages ?? credentialPages.authFileTotalPages,
    aiProviderTotalPages: clientAiProvidersPage?.totalPages ?? credentialPages.aiProviderTotalPages,
    authFileActiveOnly: credentialPages.authFileActiveOnly,
    authFileSort: credentialPages.authFileSort,
    aiProviderSort: credentialPages.aiProviderSort,
    setAuthFilePage: credentialPages.setAuthFilePage,
    setAiProviderPage: credentialPages.setAiProviderPage,
    setAuthFilePageSize: credentialPages.setAuthFilePageSize,
    setAiProviderPageSize: credentialPages.setAiProviderPageSize,
    setAuthFileActiveOnly: credentialPages.setAuthFileActiveOnly,
    setAuthFileSort: credentialPages.setAuthFileSort,
    setAiProviderSort: credentialPages.setAiProviderSort,
    loading: credentialPages.loading,
    error: credentialPages.error,
    quotaRefreshing: quotaRefreshTasks.quotaRefreshing,
    quotaRefreshError: quotaRefreshTasks.quotaRefreshError,
    refresh: credentialPages.refresh,
    refreshQuotaForCurrentAuthFilePage: quotaRefreshTasks.refreshQuotaForCurrentAuthFilePage,
    refreshQuotaForAuthIndex: quotaRefreshTasks.refreshQuotaForAuthIndex,
  }
}

export { quotaRefreshDisplayError }
