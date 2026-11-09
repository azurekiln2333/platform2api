<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Braces, Cloud, KeyRound, LoaderCircle, Palette, RefreshCw, ShieldCheck } from '@lucide/vue'
import SystemBadge from '../components/SystemBadge.vue'
import {
  authConfig,
  loadAuthConfig,
  loadPanelSettings,
  panelSettings,
  refreshOverview,
} from '../panel.ts'
import {
  SYSTEMS,
  healthLabel,
  healthTone,
  serviceHealth,
  serviceInfo,
  systemMeta,
} from '../systems.ts'

const props = defineProps<{ dark: boolean }>()
const emit = defineEmits<{ 'toggle-theme': [] }>()

const version = __APP_VERSION__
const loginModes = computed(() => [
  ...(authConfig.value.keyLoginEnabled ? ['管理密钥（PANEL_ADMIN_KEY）'] : []),
  ...(authConfig.value.sso.enabled
    ? [`单点登录（${authConfig.value.sso.providerName.trim() || 'OIDC'}）`]
    : []),
])
const services = computed(() =>
  SYSTEMS.map((system) => {
    const info = serviceInfo(panelSettings.value, system.id)
    return { meta: system, info, health: serviceHealth(info) }
  }),
)

onMounted(() => {
  void loadPanelSettings()
  void loadAuthConfig()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> SETTINGS</span>
        <h1>面板设置</h1>
        <p>
          面板的服务地址、访问令牌与管理密钥全部来自容器环境变量；这里只读展示接入状态，令牌不会回显。
        </p>
      </div>
      <div class="heading-actions">
        <button class="button" @click="loadPanelSettings">
          <RefreshCw :size="15" /><span>重新读取</span>
        </button>
      </div>
    </header>

    <div class="section-panel" data-testid="settings-services">
      <div class="section-heading">
        <Cloud :size="18" />
        <div>
          <h2>服务接入</h2>
          <p>三家服务各自独立运行；面板只通过内部地址代理管理请求，不改动它们的模型调用入口。</p>
        </div>
        <span class="subtle">PANEL_SERVICES</span>
      </div>
      <div class="table-scroll">
        <table class="account-table">
          <thead>
            <tr>
              <th>系统</th>
              <th>服务</th>
              <th>内部地址</th>
              <th>访问令牌</th>
              <th>健康状态</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="service in services"
              :key="service.meta.id"
              :data-testid="`setting-${service.meta.id}`"
            >
              <td><SystemBadge :system="service.meta.id" /></td>
              <td>
                <strong class="account-name">{{ service.meta.service }}</strong>
                <span class="cell-secondary">{{ service.meta.label }}</span>
              </td>
              <td>
                <code class="mono">{{ service.info?.url ?? '由服务端环境变量配置' }}</code>
              </td>
              <td>
                <span v-if="service.info?.stub === true" class="status-badge pending">
                  <i />占位适配器
                </span>
                <span v-else-if="service.info?.tokenConfigured === true" class="status-badge">
                  <i />已配置
                </span>
                <span
                  v-else-if="service.info?.tokenConfigured === false"
                  class="status-badge pending"
                >
                  <i />未配置
                </span>
                <span v-else class="cell-secondary">—</span>
              </td>
              <td>
                <span v-if="service.health" class="health-pill">
                  <i class="status-dot" :class="healthTone(service.health)" />{{
                    healthLabel(service.health)
                  }}
                </span>
                <span v-else class="cell-secondary">{{ service.info?.message ?? '尚未探测' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!panelSettings" class="inline-hint">
        <LoaderCircle :size="14" class="spin" /><span
          >面板尚未提供设置接口（GET /api/settings），接入信息暂不可读。</span
        >
      </p>
    </div>

    <div class="settings-grid">
      <div class="section-panel">
        <div class="section-heading">
          <ShieldCheck :size="18" />
          <div>
            <h2>登录与权限</h2>
            <p>面板只有管理员一种身份，与会话保持与各系统一致。</p>
          </div>
        </div>
        <div class="settings-fields readonly">
          <label>
            启用的登录方式
            <small>{{ loginModes.length ? loginModes.join(' · ') : '未配置登录方式' }}</small>
          </label>
          <label>
            会话
            <small>HttpOnly 不透明会话 Cookie，退出后立即失效</small>
          </label>
          <label>
            角色
            <small>单一管理员，无多角色切换</small>
          </label>
        </div>
      </div>

      <div class="section-panel">
        <div class="section-heading">
          <Braces :size="18" />
          <div>
            <h2>面板信息</h2>
            <p>版本与数据位置来自面板自身。</p>
          </div>
        </div>
        <div class="settings-fields readonly">
          <label>
            控制台版本
            <small>v{{ panelSettings?.version ?? version }}</small>
          </label>
          <label>
            面板地址
            <small>{{ panelSettings?.panelUrl ?? 'http://127.0.0.1:9000' }}</small>
          </label>
          <label>
            数据目录
            <small>{{ panelSettings?.dataDir ?? 'data/panel（标签等面板自有数据）' }}</small>
          </label>
        </div>
      </div>

      <div class="section-panel">
        <div class="section-heading">
          <Palette :size="18" />
          <div>
            <h2>外观</h2>
            <p>与本地面板一致的主题切换，保存在浏览器端。</p>
          </div>
        </div>
        <div class="settings-fields readonly">
          <label>
            主题
            <small>{{ props.dark ? '深色' : '浅色' }}</small>
          </label>
          <div class="button-group">
            <button class="button" @click="emit('toggle-theme')">切换主题</button>
            <button class="button" @click="refreshOverview">
              <RefreshCw :size="14" /><span>刷新概览</span>
            </button>
          </div>
        </div>
      </div>

      <div class="section-panel">
        <div class="section-heading">
          <KeyRound :size="18" />
          <div>
            <h2>安全边界</h2>
            <p>面板不做模型转发，也不保存上游凭据。</p>
          </div>
        </div>
        <div class="settings-fields readonly">
          <label>
            模型调用
            <small
              >继续直连各家服务原有地址与密钥（{{
                SYSTEMS.map((s) => systemMeta(s.id).service).join(' / ')
              }}）</small
            >
          </label>
          <label>
            凭据存放
            <small>账号授权结果保存在各系统自己的数据目录，面板不写入</small>
          </label>
          <label>
            面板自有数据
            <small>标签与界面偏好</small>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>
