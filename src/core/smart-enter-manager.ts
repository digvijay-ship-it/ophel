import type { SiteAdapter } from "~adapters/base"
import type { Settings } from "~utils/storage"
import { showToast } from "~utils/toast"

export class SmartEnterManager {
  private adapter: SiteAdapter
  private settings: Settings["tab"]
  private isRunning = false
  private enterQueued = false
  private _pollInterval: ReturnType<typeof setInterval> | null = null
  private _retryInterval: ReturnType<typeof setInterval> | null = null
  private _observer: MutationObserver | null = null

  // Event handler bounds
  private boundKeyDown: (e: KeyboardEvent) => void
  private boundPaste: (e: ClipboardEvent) => void

  constructor(adapter: SiteAdapter, settings: Settings["tab"]) {
    this.adapter = adapter
    this.settings = settings

    this.boundKeyDown = this.handleKeyDown.bind(this)
    this.boundPaste = this.handlePaste.bind(this)
  }

  updateSettings(settings: Settings["tab"]) {
    this.settings = settings

    if (this.isRunning) {
      this.toggleDisclaimer()
      this.toggleScrollButton()
    }
  }

  start() {
    if (this.isRunning) return
    this.isRunning = true

    // Register keydown interceptor in capture phase
    document.addEventListener("keydown", this.boundKeyDown, true)
    // Register paste interceptor in capture phase
    document.addEventListener("paste", this.boundPaste, true)

    this.toggleDisclaimer()
    this.toggleScrollButton()

    // Observe DOM changes to dynamically re-apply features
    if (this._observer) this._observer.disconnect()
    this._observer = new MutationObserver(() => {
      this.toggleDisclaimer()
      this.toggleScrollButton()
    })
    this._observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  stop() {
    if (!this.isRunning) return
    this.isRunning = false

    document.removeEventListener("keydown", this.boundKeyDown, true)
    document.removeEventListener("paste", this.boundPaste, true)

    if (this._observer) {
      this._observer.disconnect()
      this._observer = null
    }
    if (this._pollInterval) clearInterval(this._pollInterval)
    if (this._retryInterval) clearInterval(this._retryInterval)

    const btn = document.getElementById("gem-scroll-btn")
    if (btn) btn.remove()
    const style = document.getElementById("gem-hide-style")
    if (style) style.remove()
  }

  isUploading(): boolean {
    // Standard uploader progress
    const area = document.querySelector(".xap-uploader-dropzone")
    if (
      area?.querySelector(
        '.mdc-circular-progress--indeterminate, mat-progress-spinner, mat-spinner, [role="progressbar"]',
      )
    ) {
      return true
    }

    // Image attachment not fully loaded
    const img = document.querySelector("img.gem-attachment-style-img, img[src^='blob:']")
    if (img && (img as HTMLImageElement).naturalWidth === 0) {
      return true
    }

    // Other attachment progress
    const progress = document.querySelector(
      'gem-media-attachment [role="progressbar"], .xap-uploader-dropzone [role="progressbar"]',
    )
    if (progress) {
      return true
    }

    return false
  }

  hasAttachment(): boolean {
    return !!document.querySelector(
      "gem-media-attachment, .xap-uploader-dropzone img, .gem-attachment-style-img, [class*='attachment-']",
    )
  }

  findSubmitButton(): HTMLElement | null {
    const selectors = (this.adapter as any).getSubmitButtonSelectors?.() || [
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="\\u53d1\\u9001"]',
      ".send-button",
    ]
    for (const sel of selectors) {
      const btn = document.querySelector(sel)
      if (btn) return btn as HTMLElement
    }
    return null
  }

  findActualInputBox(): HTMLElement | null {
    if ((this.adapter as any).textarea && (this.adapter as any).textarea.isConnected) {
      return (this.adapter as any).textarea
    }
    return (
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('.text-input-field_textarea-wrapper [contenteditable="true"]') ||
      document.querySelector("textarea, .ProseMirror")
    )
  }

  handlePaste(e: ClipboardEvent) {
    if (!this.settings.pasteFocusFix) return

    const hasFiles = e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0
    if (hasFiles) {
      let attempts = 0
      const focusInterval = setInterval(() => {
        const chatBox = this.findActualInputBox()
        if (chatBox) {
          chatBox.focus()
        }
        attempts++
        if (attempts > 20) {
          clearInterval(focusInterval)
        }
      }, 50)
    } else {
      setTimeout(() => {
        const chatBox = this.findActualInputBox()
        if (chatBox) chatBox.focus()
      }, 50)
    }
  }

  handleKeyDown(e: KeyboardEvent) {
    if (!this.settings.smartEnter) return
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey) return

    const active = document.activeElement
    const inInput =
      active &&
      (active.tagName === "TEXTAREA" ||
        active.getAttribute("contenteditable") === "true" ||
        active.closest('[contenteditable="true"]') ||
        active.closest(".xap-uploader-dropzone"))

    if (!inInput) return

    if (this.hasAttachment() && this.isUploading()) {
      e.preventDefault()
      e.stopPropagation()

      if (!this.enterQueued) {
        this.enterQueued = true
        showToast("Queued submit (waiting for upload)...")
        this.pollForUploadDone()
      }
    }
  }

  pollForUploadDone() {
    if (this._pollInterval) clearInterval(this._pollInterval)

    let elapsed = 0
    this._pollInterval = setInterval(() => {
      elapsed += 100
      if (!this.enterQueued) {
        if (this._pollInterval) clearInterval(this._pollInterval)
        return
      }

      if (!this.isUploading()) {
        if (this._pollInterval) clearInterval(this._pollInterval)
        this.retrySubmit()
        return
      }

      if (elapsed > 30000) {
        this.enterQueued = false
        if (this._pollInterval) clearInterval(this._pollInterval)
        showToast("Upload timeout (queue canceled).")
      }
    }, 100)
  }

  retrySubmit() {
    if (this._retryInterval) clearInterval(this._retryInterval)

    let attempts = 0
    this._retryInterval = setInterval(() => {
      attempts++
      if (!this.enterQueued) {
        if (this._retryInterval) clearInterval(this._retryInterval)
        return
      }

      const btn = this.findSubmitButton()
      if (
        btn &&
        !(btn as HTMLButtonElement).disabled &&
        (btn as HTMLElement).offsetParent !== null
      ) {
        btn.click()
        this.enterQueued = false
        if (this._retryInterval) clearInterval(this._retryInterval)
        return
      }

      if (attempts > 20) {
        this.enterQueued = false
        if (this._retryInterval) clearInterval(this._retryInterval)
        showToast("Could not auto-submit (submit button disabled).")
      }
    }, 150)
  }

  toggleDisclaimer() {
    const hide = this.settings.hideDisclaimer
    let style = document.getElementById("gem-hide-style")
    if (hide) {
      if (!style) {
        style = document.createElement("style")
        style.id = "gem-hide-style"
        style.textContent = `p[data-test-id="disclaimer"] { display: none !important; }`
        document.head.appendChild(style)
      }
    } else {
      if (style) style.remove()
    }
  }

  toggleScrollButton() {
    const show = this.settings.showScrollBtn
    const btn = document.getElementById("gem-scroll-btn")
    if (show) {
      if (!btn) this.addScrollButton()
    } else {
      if (btn) btn.remove()
    }
  }

  addScrollButton() {
    if (document.getElementById("gem-scroll-btn")) return
    const btn = document.createElement("button")
    btn.id = "gem-scroll-btn"
    btn.textContent = "▼"
    btn.title = "Scroll to bottom"
    btn.addEventListener("click", () => {
      const containers = document.querySelectorAll("*")
      for (const el of containers) {
        if (el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop = el.scrollHeight
        }
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
    })

    // Add styles for floating scroll button matching premium style
    const styleId = "gem-scroll-btn-style"
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style")
      style.id = styleId
      style.textContent = `
        #gem-scroll-btn {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4285F4, #9B51E0);
          color: white;
          border: none;
          font-size: 18px;
          cursor: pointer;
          z-index: 10000;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s, background 0.2s;
        }
        #gem-scroll-btn:hover {
          transform: scale(1.1);
        }
      `
      document.head.appendChild(style)
    }

    document.body.appendChild(btn)
  }
}
