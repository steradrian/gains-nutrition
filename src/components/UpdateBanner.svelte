<script>
  /**
   * UpdateBanner — top-of-app dismissible banner shown when the service
   * worker has a fresh bundle waiting (web only, see App.svelte's hook for
   * the trigger). "Reload" activates it.
   *
   * Reloading takes a bundle that is already downloaded; a page cannot
   * install anything, so the copy never says "install". Dismissing hides
   * the banner for this session; the next page load surfaces it again.
   */
  import { _ } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { portal } from '../lib/portal.js';
  import { pwaUpdateReady, applyPwaUpdate } from '../lib/pwa-update.js';

  let dismissed = false;
</script>

{#if $pwaUpdateReady && !dismissed}
  <div
    class="update-banner"
    use:portal
    transition:fade={{ duration: 200 }}
    role="status"
    aria-live="polite"
  >
    <span class="material-symbols-rounded icon" aria-hidden="true">system_update</span>
    <div class="body">
      <div class="title">{$_('updates.ready_headline')}</div>
      <div class="sub">{$_('updates.ready_cta')}</div>
    </div>
    <button class="btn primary" on:click={applyPwaUpdate}>{$_('updates.banner_reload')}</button>
    <button class="dismiss" on:click={() => (dismissed = true)} aria-label={$_('common.close')}>
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </button>
  </div>
{/if}

<style>
  /* Portaled to document.body so page transforms can't trap it in a
     lower stacking context (same pattern as .sync-connection-banner in
     App.svelte). Sits just below the status bar / camera cutout via
     the safe-area inset. */
  .update-banner {
    position: fixed;
    top: var(--safe-top, env(safe-area-inset-top, 0px));
    left: calc(var(--sidebar-w, 0px) + 12px);
    right: 12px;
    z-index: 250;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 15%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: var(--radius-lg, 12px);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.25));
    color: var(--text-1);
    transition: left 0.25s ease;
  }
  .icon { color: var(--accent); flex-shrink: 0; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 14px; }
  .sub   { font-size: 12px; color: var(--text-2); }
  .btn.primary {
    background: var(--accent); color: white; border: none;
    padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
    flex-shrink: 0;
  }
  .dismiss {
    background: transparent; border: none; padding: 4px; cursor: pointer;
    display: flex; align-items: center; color: var(--text-2);
    flex-shrink: 0;
  }
  .dismiss:hover { color: var(--text-1); }
</style>
