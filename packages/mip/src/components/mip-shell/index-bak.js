/* istanbul ignore file */
/**
 * @file MIP Shell Base
 * @author wangyisheng@baidu.com (wangyisheng)
 */

import {
  convertPatternToRegexp,
  createMoreButtonWrapper,
  createPageMask,
  toggleInner
} from './util'
import {makeCacheUrl} from '../../util'
import css from '../../util/dom/css'
import fn from '../../util/fn'
import platform from '../../util/platform'
import event from '../../util/dom/event'
import CustomElement from '../../custom-element'
import {supportsPassive} from '../../page/util/feature-detect'
import {isSameRoute, getFullPath} from '../../page/util/route'
import {
  createIFrame,
  getIFrame,
  frameMoveIn,
  frameMoveOut,
  createLoading,
  createFadeHeader,
  toggleFadeHeader
} from '../../page/util/dom'
import {getCleanPageId} from '../../page/util/path'
import Router from '../../page/router/index'
import {
  DEFAULT_SHELL_CONFIG,
  NON_EXISTS_PAGE_ID,
  CUSTOM_EVENT_SCROLL_TO_ANCHOR,
  CUSTOM_EVENT_RESIZE_PAGE,
  CUSTOM_EVENT_SHOW_PAGE,
  CUSTOM_EVENT_HIDE_PAGE,
  MESSAGE_ROUTER_PUSH,
  MESSAGE_ROUTER_REPLACE,
  MESSAGE_ROUTER_BACK,
  MESSAGE_ROUTER_FORWARD,
  MESSAGE_CROSS_ORIGIN,
  MESSAGE_BROADCAST_EVENT,
  MESSAGE_PAGE_RESIZE
} from '../../page/const/index'
import viewport from '../../viewport'
import {customEmit} from '../../vue-custom-element/utils/custom-event'

let viewer = null
let page = null
window.MIP_PAGE_META_CACHE = Object.create(null)
window.MIP_SHELL_CONFIG = null

class MipShell extends CustomElement {
  // ===================== CustomElement LifeCycle =====================
  constructor (...args) {
    super(...args)

    this.messageHandlers = []

    // If true, always load configures from `<mip-shell>` and overwrite shellConfig when opening new page
    this.alwaysReadConfigOnLoad = true

    // If true, page switching transition contains header
    this.transitionContainsHeader = true
  }

  build () {
    viewer = window.MIP.viewer
    page = viewer.page

    // Read config
    let ele = this.element.querySelector('script[type="application/json"]')
    let tmpShellConfig

    if (!ele) {
      tmpShellConfig = {
        routes: [{
          pattern: '*',
          meta: DEFAULT_SHELL_CONFIG
        }]
      }
    } else {
      try {
        tmpShellConfig = JSON.parse(ele.textContent.toString()) || {}
        if (tmpShellConfig.alwaysReadConfigOnLoad !== undefined) {
          this.alwaysReadConfigOnLoad = tmpShellConfig.alwaysReadConfigOnLoad
        }
        if (tmpShellConfig.transitionContainsHeader !== undefined) {
          this.transitionContainsHeader = tmpShellConfig.transitionContainsHeader
        }
        if (!tmpShellConfig.routes) {
          tmpShellConfig.routes = [{
            pattern: '*',
            meta: DEFAULT_SHELL_CONFIG
          }]
        }
      } catch (e) {
        tmpShellConfig = {
          routes: [{
            pattern: '*',
            meta: DEFAULT_SHELL_CONFIG
          }]
        }
      }
    }

    if (page.isRootPage) {
      tmpShellConfig.routes.forEach(route => {
        route.meta = fn.extend(true, {}, DEFAULT_SHELL_CONFIG, route.meta || {})
        route.regexp = convertPatternToRegexp(route.pattern || '*')

        // Get title from <title> tag
        if (!route.meta.header.title) {
          route.meta.header.title = (document.querySelector('title') || {}).innerHTML || ''
        }
      })
      this.processShellConfig(tmpShellConfig)

      window.MIP_SHELL_CONFIG = tmpShellConfig.routes
      // Append other DOM
      let children = this.element.children
      let otherDOM = [].slice.call(children).slice(1, children.length)
      if (otherDOM.length > 0) {
        otherDOM.forEach(dom => {
          dom.setAttribute('mip-shell-inner', '')
          document.body.appendChild(dom)
        })
      }
    } else {
      let pageId = page.pageId
      let pageMeta

      if (page.isCrossOrigin) {
        // If this iframe is a cross origin one
        // Read all config and save it in window.
        // Avoid find page meta from `window.parent`
        tmpShellConfig.routes.forEach(route => {
          route.meta = fn.extend(true, {}, DEFAULT_SHELL_CONFIG, route.meta || {})
          route.regexp = convertPatternToRegexp(route.pattern || '*')

          // Get title from <title> tag
          if (!route.meta.header.title) {
            route.meta.header.title = (document.querySelector('title') || {}).innerHTML || ''
          }

          // Find current page meta
          if (route.regexp.test(pageId)) {
            pageMeta = window.MIP_PAGE_META_CACHE[pageId] = route.meta
          }
        })

        window.MIP_SHELL_CONFIG = tmpShellConfig.routes
        window.MIP_PAGE_META_CACHE = Object.create(null)
      } else if (this.alwaysReadConfigOnLoad) {
        // If `alwaysReadConfigOnLoad` equals `true`
        // Read config in leaf pages and pick up the matched one. Send it to page for updating.
        pageMeta = DEFAULT_SHELL_CONFIG
        for (let i = 0; i < tmpShellConfig.routes.length; i++) {
          let config = tmpShellConfig.routes[i]
          config.regexp = convertPatternToRegexp(config.pattern || '*')

          // Only process matched page meta
          if (config.regexp.test(pageId)) {
            config.meta = fn.extend(true, {}, DEFAULT_SHELL_CONFIG, config.meta || {})
            // get title from <title> tag
            if (!config.meta.header.title) {
              config.meta.header.title = (document.querySelector('title') || {}).innerHTML || ''
            }

            pageMeta = window.parent.MIP_PAGE_META_CACHE[pageId] = config.meta
            break
          }
        }
      }

      if (!pageMeta) {
        pageMeta = this.findMetaByPageId(pageId)
      }

      page.emitCustomEvent(window.parent, page.isCrossOrigin, {
        name: 'mipShellEvents',
        data: {
          type: 'updateShell',
          data: {pageMeta}
        }
      })
    }
  }

  prerenderAllowed () {
    return true
  }

  firstInviewCallback () {
    this.currentPageMeta = this.findMetaByPageId(page.pageId)

    if (page.isRootPage) {
      this.initShell()
      this.initRouter()
      this.bindRootEvents()
    }

    this.bindAllEvents()
  }

  disconnectedCallback () {
    if (page.isRootPage) {
      this.unbindHeaderEvents()
    }
  }

  // ===================== Only Root Page Functions =====================

  /**
   * Create belows:
   * 1. Shell wrapper
   * 2. Header
   * 3. Button wrapper & mask
   * 4. Page mask (mainly used to cover header)
   */
  initShell () {
    // Shell wrapper
    this.$wrapper = document.createElement('mip-fixed')
    this.$wrapper.setAttribute('type', 'top')
    this.$wrapper.classList.add('mip-shell-header-wrapper')
    if (!(this.currentPageMeta.header && this.currentPageMeta.header.show)) {
      this.$wrapper.classList.add('hide')
    }

    // Header
    this.$el = document.createElement('div')
    this.$el.classList.add('mip-shell-header', 'transition')
    this.renderHeader(this.$el)
    this.$wrapper.insertBefore(this.$el, this.$wrapper.firstChild)

    document.body.insertBefore(this.$wrapper, document.body.firstChild)

    // Button wrapper & mask
    let buttonGroup = this.currentPageMeta.header.buttonGroup
    let {mask, buttonWrapper} = createMoreButtonWrapper(buttonGroup)
    this.$buttonMask = mask
    this.$buttonWrapper = buttonWrapper

    // Page mask
    this.$pageMask = createPageMask()

    // Loading
    this.$loading = createLoading(this.currentPageMeta)

    // Fade header
    if (!this.transitionContainsHeader) {
      this.$fadeHeader = createFadeHeader(this.currentPageMeta)
    }

    // Other parts
    this.renderOtherParts()

    window.MIP.viewer.fixedElement.init()
  }

  renderHeader (container) {
    let pageMeta = this.currentPageMeta
    let {
      buttonGroup,
      title,
      logo,
      color = '#000000',
      borderColor,
      backgroundColor = '#ffffff'
    } = pageMeta.header
    let showBackIcon = !pageMeta.view.isIndex

    let headerHTML = `
      ${showBackIcon ? `<a href="javascript:void(0)" class="back-button" mip-header-btn
        data-button-name="back">
        <svg t="1530857979993" class="icon" style="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="3173"
          xmlns:xlink="http://www.w3.org/1999/xlink">
          <path  fill="currentColor" d="M348.949333 511.829333L774.250667 105.728C783.978667 96 789.333333 83.712 789.333333 71.104c0-12.629333-5.354667-24.917333-15.082666-34.645333-9.728-9.728-22.037333-15.082667-34.645334-15.082667-12.586667 0-24.917333 5.333333-34.624 15.082667L249.557333 471.616A62.570667 62.570667 0 0 0 234.666667 512c0 10.410667 1.130667 25.408 14.890666 40.042667l455.424 435.605333c9.706667 9.728 22.016 15.082667 34.624 15.082667s24.917333-5.354667 34.645334-15.082667c9.728-9.728 15.082667-22.037333 15.082666-34.645333 0-12.608-5.354667-24.917333-15.082666-34.645334L348.949333 511.829333z"
            p-id="3174"></path>
        </svg>
      </a>` : ''}
      <div class="mip-shell-header-logo-title">
        ${logo ? `<img class="mip-shell-header-logo" src="${logo}">` : ''}
        <span class="mip-shell-header-title">${title}</span>
      </div>
    `

    let moreFlag = Array.isArray(buttonGroup) && buttonGroup.length > 0
    let closeFlag = !window.MIP.standalone && this.showHeaderCloseButton()

    if (moreFlag && closeFlag) {
      // more & close
      headerHTML += `
        <div class="mip-shell-header-button-group">
          <div class="button more" mip-header-btn data-button-name="more">
            <svg t="1530857985972" class="icon" style="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="3393"
              xmlns:xlink="http://www.w3.org/1999/xlink">
              <path d="M128 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3394" fill="currentColor"></path>
              <path d="M512 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3395" fill="currentColor"></path>
              <path d="M896 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3396" fill="currentColor"></path>
            </svg>
          </div>
          <div class="split"></div>
          <div class="button close" mip-header-btn data-button-name="close">
            <svg t="1530857971603" class="icon" style="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2953"
              xmlns:xlink="http://www.w3.org/1999/xlink">
              <path  fill="currentColor" d="M586.026667 533.248l208.789333-208.576c9.856-8.874667 15.488-21.248 15.850667-34.858667a53.717333 53.717333 0 0 0-15.829334-39.146666 48.042667 48.042667 0 0 0-36.224-15.872c-14.165333 0-27.584 5.632-37.802666 15.850666L512 459.221333l-208.789333-208.576a48.042667 48.042667 0 0 0-36.245334-15.850666c-14.144 0-27.562667 5.632-37.781333 15.850666A48.085333 48.085333 0 0 0 213.333333 285.504a53.717333 53.717333 0 0 0 15.850667 39.168l208.789333 208.576-208.576 208.853333a48.085333 48.085333 0 0 0-15.850666 34.88 53.717333 53.717333 0 0 0 15.850666 39.146667c9.194667 10.24 22.058667 15.872 36.224 15.872 14.144 0 27.562667-5.632 37.802667-15.850667L512 607.274667l208.597333 208.853333c9.216 10.24 22.08 15.872 36.224 15.872s27.584-5.632 37.802667-15.850667c9.856-8.874667 15.488-21.269333 15.850667-34.88a53.717333 53.717333 0 0 0-15.850667-39.146666l-208.597333-208.853334z"
                p-id="2954"></path>
            </svg>
          </div>
        </div>
     `
    } else if (moreFlag && !closeFlag) {
      // only more
      headerHTML += `
        <div class="mip-shell-header-button-group-standalone more" mip-header-btn data-button-name="more">
          <svg t="1530857985972" class="icon" style="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="3393"
            xmlns:xlink="http://www.w3.org/1999/xlink">
            <path d="M128 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3394" fill="currentColor"></path>
            <path d="M512 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3395" fill="currentColor"></path>
            <path d="M896 512m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="3396" fill="currentColor"></path>
          </svg>
        </div>
     `
    } else if (!moreFlag && closeFlag) {
      // only close
      headerHTML += `
        <div class="mip-shell-header-button-group-standalone">
          <div class="button close" mip-header-btn data-button-name="close">
            <svg t="1530857971603" class="icon" style="" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2953"
              xmlns:xlink="http://www.w3.org/1999/xlink">
              <path  fill="currentColor" d="M586.026667 533.248l208.789333-208.576c9.856-8.874667 15.488-21.248 15.850667-34.858667a53.717333 53.717333 0 0 0-15.829334-39.146666 48.042667 48.042667 0 0 0-36.224-15.872c-14.165333 0-27.584 5.632-37.802666 15.850666L512 459.221333l-208.789333-208.576a48.042667 48.042667 0 0 0-36.245334-15.850666c-14.144 0-27.562667 5.632-37.781333 15.850666A48.085333 48.085333 0 0 0 213.333333 285.504a53.717333 53.717333 0 0 0 15.850667 39.168l208.789333 208.576-208.576 208.853333a48.085333 48.085333 0 0 0-15.850666 34.88 53.717333 53.717333 0 0 0 15.850666 39.146667c9.194667 10.24 22.058667 15.872 36.224 15.872 14.144 0 27.562667-5.632 37.802667-15.850667L512 607.274667l208.597333 208.853333c9.216 10.24 22.08 15.872 36.224 15.872s27.584-5.632 37.802667-15.850667c9.856-8.874667 15.488-21.269333 15.850667-34.88a53.717333 53.717333 0 0 0-15.850667-39.146666l-208.597333-208.853334z"
                p-id="2954"></path>
            </svg>
          </div>
        </div>
      `
    }

    container.innerHTML = headerHTML

    // Set color & borderColor & backgroundColor
    css(container, 'background-color', backgroundColor)
    css(container.querySelectorAll('svg'), 'fill', color)
    css(container.querySelector('.mip-shell-header-title'), 'color', color)
    css(container.querySelector('.mip-shell-header-logo'), 'border-color', borderColor)
    css(container.querySelector('.mip-shell-header-button-group'), 'border-color', borderColor)
    css(container.querySelector('.mip-shell-header-button-group .split'), 'background-color', borderColor)
  }

  initRouter () {
    // Init router
    let router = new Router()
    router.init()
    router.listen(this.render.bind(this))
    this.router = router

    // Handle events emitted by SF
    viewer.onMessage('changeState', ({url}) => {
      router.replace(makeCacheUrl(url, 'url', true))
    })

    window.MIP_SHELL_OPTION = {
      allowTransition: false,
      direction: null
    }

    window.addEventListener('message', e => {
      let type
      let data
      try {
        type = e.data.type
        data = e.data.data
      } catch (e) {
        // Ignore other messages
        return
      }

      // Deal message and operate router
      if (type === MESSAGE_ROUTER_PUSH) {
        if (data.options.allowTransition) {
          window.MIP_SHELL_OPTION.allowTransition = true
        }
        router.push(data.route)
      } else if (type === MESSAGE_ROUTER_REPLACE) {
        if (data.options.allowTransition) {
          window.MIP_SHELL_OPTION.allowTransition = true
        }
        router.replace(data.route)
      } else if (type === MESSAGE_ROUTER_BACK) {
        window.MIP_SHELL_OPTION.allowTransition = true
        router.back()
      } else if (type === MESSAGE_ROUTER_FORWARD) {
        window.MIP_SHELL_OPTION.allowTransition = true
        router.forward()
      }
    }, false)
  }

  bindRootEvents () {
    this.currentViewportHeight = viewport.getHeight()
    this.currentViewportWidth = viewport.getWidth()

    // Receive and resend message
    this.messageHandlers.push((type, data) => {
      if (type === MESSAGE_BROADCAST_EVENT) {
        // Broadcast Event
        page.broadcastCustomEvent(data)
      } else if (type === MESSAGE_PAGE_RESIZE) {
        this.resizeAllPages()
      }
    })

    // update every iframe's height when viewport resizing
    viewport.on('resize', () => {
      // only when screen gets spinned
      let currentViewportWidth = viewport.getWidth()
      if (this.currentViewportWidth !== currentViewportWidth) {
        this.currentViewportHeight = viewport.getHeight()
        this.currentViewportWidth = currentViewportWidth
        this.resizeAllPages()
      }
    })

    // Listen events
    window.addEventListener('mipShellEvents', e => {
      let {type, data} = e.detail[0]

      switch (type) {
        case 'updateShell':
          this.refreshShell({pageMeta: data.pageMeta})
          break
        case 'slide':
          this.slideHeader(data.direction)
          break
        case 'togglePageMask':
          this.togglePageMask(data.toggle, data.options)
          break
        case 'toggleDropdown':
          this.toggleDropdown(data.toggle)
          break
        case 'toggleTransition':
          this.toggleTransition(data.toggle)
          break
      }
    })

    // Bind DOM events
    this.bindHeaderEvents()

    window.MIP.viewer.eventAction.execute('active', this.element, {})
  }

  /**
   * render with current route
   *
   * @param {Route} from route
   * @param {Route} to route
   */
  render (from, to) {
    this.resizeAllPages()
    /**
     * if `to` route is the same with `from` route in path & query,
     * scroll in current page
     */
    if (isSameRoute(from, to, true)) {
      // Emit event to current active page
      page.emitEventInCurrentPage({
        name: CUSTOM_EVENT_SCROLL_TO_ANCHOR,
        data: to.hash
      })
      return
    }

    // Render target page
    let targetFullPath = getFullPath(to)
    let targetPageId = getCleanPageId(targetFullPath)
    let targetPage = page.getPageById(targetPageId)

    if (page.currentPageId === page.pageId) {
      this.saveScrollPosition()
    }

    // Hide page mask and skip transition
    this.togglePageMask(false, {skipTransition: true})

    // Show header
    this.slideHeader('down')
    this.pauseBouncyHeader = true
    /**
     * Reload iframe when <a mip-link> clicked even if it's already existed.
     * NOTE: forwarding or going back with browser history won't do
     */
    let needEmitPageEvent = true
    if (!targetPage || (to.meta && to.meta.reload)) {
      // When reloading root page...
      if (page.pageId === targetPageId) {
        page.pageId = NON_EXISTS_PAGE_ID
        // Destroy root page first
        if (targetPage) {
          targetPage.destroy()
        }
        // Delete DOM & trigger disconnectedCallback in root page
        Array.prototype.slice.call(page.getElementsInRootPage()).forEach(el => el.parentNode && el.parentNode.removeChild(el))
      }

      page.checkIfExceedsMaxPageNum()

      let targetPageMeta = {
        pageId: targetPageId,
        fullpath: targetFullPath,
        standalone: window.MIP.standalone,
        isRootPage: false,
        isCrossOrigin: to.origin !== window.location.origin
      }

      let iframeCreated = false
      let targetIFrame
      // qqbrowser contains bugs when [pushState] and [create iframe] invoked together
      // Ensure [create iframe] before [pushState] and eliminate async operations
      if (platform.isQQ() || platform.isQQApp()) {
        targetIFrame = createIFrame(targetPageMeta)
        targetPageMeta.targetWindow = targetIFrame.contentWindow
        iframeCreated = true
        window.MIP_SHELL_OPTION.allowTransition = false
      }
      page.addChild(targetPageMeta)
      needEmitPageEvent = false
      this.applyTransition(targetPageId, to.meta, {
        newPage: true,
        onComplete: () => {
          if (!iframeCreated) {
            targetIFrame = createIFrame(targetPageMeta)
            targetPageMeta.targetWindow = targetIFrame.contentWindow
          }
          css(targetIFrame, {
            display: 'block',
            opacity: 1
          })
          // Get <mip-shell> from root page
          let shellDOM = document.querySelector('mip-shell') || document.querySelector('[mip-shell]')
          if (shellDOM) {
            viewer.eventAction.execute('active', shellDOM, {})
          }
          page.emitEventInCurrentPage({name: CUSTOM_EVENT_HIDE_PAGE})
          page.currentPageId = targetPageId
          page.emitEventInCurrentPage({name: CUSTOM_EVENT_SHOW_PAGE})
        }
      })
    } else {
      if (platform.isQQ() || platform.isQQApp()) {
        window.MIP_SHELL_OPTION.allowTransition = false
      }
      this.applyTransition(targetPageId, to.meta, {
        onComplete: () => {
          css(getIFrame(targetPageId), {
            display: 'block',
            opacity: 1
          })
          // Update shell if new iframe has not been created
          let pageMeta = this.findMetaByPageId(targetPageId)
          this.refreshShell({pageMeta})
          // Get <mip-shell> from root page
          let shellDOM = document.querySelector('mip-shell') || document.querySelector('[mip-shell]')
          if (shellDOM) {
            viewer.eventAction.execute('active', shellDOM, {})
          }
        }
      })
      window.MIP.$recompile()
    }

    if (needEmitPageEvent) {
      page.emitEventInCurrentPage({name: CUSTOM_EVENT_HIDE_PAGE})
      page.currentPageId = targetPageId
      page.emitEventInCurrentPage({name: CUSTOM_EVENT_SHOW_PAGE})
    }
  }

  /**
   * save scroll position in root page
   */
  saveScrollPosition () {
    this.rootPageScrollPosition = viewport.getScrollTop()
  }

  /**
   * restore scroll position in root page
   */
  restoreScrollPosition () {
    viewport.setScrollTop(this.rootPageScrollPosition)
  }

  /**
   * apply transition effect to relative two pages
   *
   * @param {string} targetPageId targetPageId
   * @param {Object} targetMeta metainfo of targetPage
   * @param {Object} options
   * @param {Object} options.newPage if just created a new page
   * @param {Function} options.onComplete if just created a new page
   */
  applyTransition (targetPageId, targetMeta, options = {}) {
    let localMeta = this.findMetaByPageId(targetPageId)
    /**
     * priority of header.title:
     * 1. <a mip-link data-title>
     * 2. <mip-shell> route.meta.header.title
     * 3. <a mip-link></a> innerText
     */
    let innerTitle = {title: targetMeta.defaultTitle || undefined}
    let finalMeta = fn.extend(true, innerTitle, localMeta, targetMeta)

    this.toggleTransition(false)

    if (targetPageId === page.pageId || window.MIP_SHELL_OPTION.direction === 'back') {
      // backward
      let backwardOpitons = {
        sourceMeta: this.currentPageMeta,
        transitionContainsHeader: this.transitionContainsHeader,
        onComplete: () => {
          this.currentPageMeta = finalMeta
          this.toggleTransition(true)
          this.pauseBouncyHeader = false
          if (window.MIP_SHELL_OPTION.direction === 'back' && targetPageId !== page.pageId) {
            document.documentElement.classList.add('mip-no-scroll')
            Array.prototype.slice.call(page.getElementsInRootPage()).forEach(e => e.classList.add('hide'))
          }
          options.onComplete && options.onComplete()
        }
      }

      if (window.MIP_SHELL_OPTION.direction === 'back') {
        backwardOpitons.targetPageId = targetPageId
        backwardOpitons.targetPageMeta = this.findMetaByPageId(targetPageId)
      } else {
        backwardOpitons.targetPageMeta = this.currentPageMeta
      }

      // move current iframe to correct position
      backwardOpitons.rootPageScrollPosition = 0
      if (targetPageId === page.pageId) {
        backwardOpitons.rootPageScrollPosition = this.rootPageScrollPosition
        document.documentElement.classList.remove('mip-no-scroll')
        Array.prototype.slice.call(page.getElementsInRootPage()).forEach(e => e.classList.remove('hide'))
      }
      frameMoveOut(page.currentPageId, backwardOpitons)

      window.MIP_SHELL_OPTION.direction = null
      // restore scroll position in root page
      if (targetPageId === page.pageId) {
        this.restoreScrollPosition()
      }
    } else {
      // forward
      frameMoveIn(targetPageId, {
        targetMeta: finalMeta,
        newPage: options.newPage,
        transitionContainsHeader: this.transitionContainsHeader,
        onComplete: () => {
          this.currentPageMeta = finalMeta
          this.toggleTransition(true)
          this.pauseBouncyHeader = false
          /**
           * Disable scrolling of root page when covered by an iframe
           * NOTE: it doesn't work in iOS, see `_lockBodyScroll()` in viewer.js
           */
          document.documentElement.classList.add('mip-no-scroll')
          Array.prototype.slice.call(page.getElementsInRootPage()).forEach(e => e.classList.add('hide'))
          options.onComplete && options.onComplete()
        }
      })
    }
  }

  /**
   * handle resize event
   */
  resizeAllPages () {
    // 1.set every page's iframe
    Array.prototype.slice.call(document.querySelectorAll('.mip-page__iframe')).forEach($el => {
      $el.style.height = `${this.currentViewportHeight}px`
    })
    // 2.notify <mip-iframe> in every page
    page.broadcastCustomEvent({
      name: CUSTOM_EVENT_RESIZE_PAGE,
      data: {
        height: this.currentViewportHeight
      }
    })
    // 3.notify SF to set the iframe outside
    viewer.sendMessage('resizeContainer', {height: this.currentViewportHeight})
  }

  bindHeaderEvents () {
    let me = this
    // Delegate header
    this.headerEventHandler = event.delegate(this.$el, '[mip-header-btn]', 'click', function (e) {
      let buttonName = this.dataset.buttonName
      me.handleClickHeaderButton(buttonName)
    })

    // Delegate dropdown button
    this.buttonEventHandler = event.delegate(this.$buttonWrapper, '[mip-header-btn]', 'click', function (e) {
      let buttonName = this.dataset.buttonName
      me.handleClickHeaderButton(buttonName)

      // Fix buttonGroup with 'link' config
      let children = this.children && this.children[0]
      if (children && children.tagName.toLowerCase() === 'a' && children.hasAttribute('mip-link')) {
        me.toggleDropdown(false)
      }
    })

    let fadeHeader = document.querySelector('#mip-page-fade-header-wrapper')
    if (fadeHeader) {
      this.fadeHeaderEventHandler = event.delegate(fadeHeader, '[mip-header-btn]', 'click', function (e) {
        if (this.dataset.buttonName === 'back') {
          window.MIP_SHELL_OPTION.allowTransition = true
          page.direction = 'back'
          page.back()
        }
      })
    }

    if (this.$buttonMask) {
      this.$buttonMask.addEventListener('click', () => this.toggleDropdown(false))
      this.$buttonMask.addEventListener('touchmove',
        e => e.preventDefault(),
        supportsPassive ? {passive: false} : false)
    }
  }

  unbindHeaderEvents () {
    if (this.headerEventHandler) {
      this.headerEventHandler()
      this.headerEventHandler = undefined
    }

    if (this.buttonEventHandler) {
      this.buttonEventHandler()
      this.buttonEventHandler = undefined
    }

    if (this.fadeHeaderEventHandler) {
      this.fadeHeaderEventHandler()
      this.fadeHeaderEventHandler = undefined
    }
  }

  handleClickHeaderButton (buttonName) {
    if (buttonName === 'back') {
      // **Important** only allow transition happens when Back btn & <a> clicked
      window.MIP_SHELL_OPTION.allowTransition = true
      window.MIP_SHELL_OPTION.direction = 'back'
      page.back()
    } else if (buttonName === 'more') {
      this.toggleDropdown(true)
    } else if (buttonName === 'close') {
      window.MIP.viewer.sendMessage('close')
    } else if (buttonName === 'cancel') {
      this.toggleDropdown(false)
    }

    this.handleShellCustomButton(buttonName)

    page.emitEventInCurrentPage({
      name: `shell-header:click-${buttonName}`
    })
  }

  /**
   *
   * @param {Object} options
   * @param {Object} pageMeta Updated pageMeta
   * @param {string} pageId Current pageId. If `pageMeta` is not provided, `pageId` will be used to find pageMeta
   * @param {boolean} asyncRefresh `true` when `refreshShell` invoked in `processShellConfig` in async mode
   */
  refreshShell ({pageMeta, pageId, asyncRefresh} = {}) {
    // Unbind header events
    this.unbindHeaderEvents()

    if (pageId) {
      pageMeta = this.findMetaByPageId(pageId)
    }
    this.currentPageMeta = pageMeta

    if (!(pageMeta.header && pageMeta.header.show)) {
      this.$wrapper.classList.add('hide')
      toggleFadeHeader(false)
      css(this.$loading, 'display', 'none')
      return
    }

    // Refresh header
    this.toggleTransition(false)
    /* eslint-disable no-unused-expressions */
    window.innerHeight
    this.slideHeader('down')
    window.innerHeight
    /* eslint-enable no-unused-expressions */
    this.toggleTransition(true)
    if (asyncRefresh) {
      // In async mode: (Invoked from `processShellConfig` by user)
      // 1. Render fade header with updated pageMeta
      // 2. Show fade header with trnasition (fade)
      // 3. Wait for transition ending
      // 4. Update real header (along with otherParts, buttonWrapper, buttonMask)
      // 5. Hide fade header
      // 6. Bind header events
      toggleFadeHeader(true, pageMeta)
      setTimeout(() => {
        this.renderHeader(this.$el)
        toggleFadeHeader(false)
        // Rebind header events
        this.bindHeaderEvents()
      }, 350)
    } else {
      // In sync mode: (Invoked from event 'updateShell' by MIP Page)
      // 1. Update real header (along with otherParts, buttonWrapper, buttonMask)
      // 2. Bind header events
      // 3. Wait for transition ending
      // 4. Hide fade header (Fade header was shown in MIP Page)
      this.renderHeader(this.$el)
      css(this.$loading, 'display', 'none')
    }

    this.updateOtherParts()

    // Button wrapper & mask
    let buttonGroup = pageMeta.header.buttonGroup
    let {mask, buttonWrapper} = createMoreButtonWrapper(buttonGroup, {update: true})
    this.$buttonMask = mask
    this.$buttonWrapper = buttonWrapper

    this.$wrapper.classList.remove('hide')

    if (!asyncRefresh) {
      if (!this.transitionContainsHeader) {
        let headerLogoTitle = this.$el.querySelector('.mip-shell-header-logo-title')
        headerLogoTitle && headerLogoTitle.classList.remove('fade-out')
      }
      toggleFadeHeader(false)

      // Rebind header events
      this.bindHeaderEvents()
    }
  }

  slideHeader (direction) {
    if (this.pauseBouncyHeader) {
      return
    }
    if (direction === 'up') {
      this.$el.classList.add('slide-up')
    } else {
      this.$el.classList.remove('slide-up')
    }
  }

  /**
   * Toggle more button wrapper
   *
   * @param {boolean} toggle display or not
   */
  toggleDropdown (toggle) {
    toggleInner(this.$buttonMask, toggle)
    toggleInner(this.$buttonWrapper, toggle, {transitionName: 'slide'})
  }

  /**
   * Toggle display of page mask
   * Mainly used to cover header in iframes
   *
   * @param {boolean} toggle display or not
   * @param {Object} options
   * @param {boolean} options.skipTransition show result without transition
   */
  togglePageMask (toggle, {skipTransition} = {}) {
    toggleInner(this.$pageMask, toggle, {skipTransition})
  }

  /**
   * Toggle something
   *
   * @param {HTMLElement} dom
   * @param {boolean} toggle
   * @param {Object} options
   * @param {boolean} options.skipTransition Show result without transition
   * @param {boolean} options.transitionName Transition name. Defaults to 'fade'
   */
  toggleDOM (dom, toggle, options) {
    toggleInner(dom, toggle, options)
  }

  /**
   * Toggle header transition class
   * Remove transition during page switching
   *
   * @param {boolean} toggle
   */
  toggleTransition (toggle) {
    toggle ? this.$el.classList.add('transition') : this.$el.classList.remove('transition')
  }

  // ===================== All Page Functions =====================
  bindAllEvents () {
    // Don't let browser restore scroll position.
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }

    let {show: showHeader, bouncy} = this.currentPageMeta.header
    // Set `padding-top` on scroller
    if (showHeader) {
      document.body.classList.add('with-header')
    }

    if (bouncy) {
      page.setupBouncyHeader()
    }

    // Cross origin
    this.messageHandlers.push((type, data) => {
      if (type === MESSAGE_CROSS_ORIGIN) {
        customEmit(window, data.name, data.data)
      }
    })

    window.addEventListener('message', e => {
      try {
        this.messageHandlers.forEach(handler => {
          handler.call(this, e.data.type, e.data.data || {})
        })
      } catch (e) {
        // Message sent from SF will cause cross domain error when reading e.source.location
        // Just ignore these messages.
      }
    }, false)
  }

  updateShellConfig (newShellConfig) {
    if (page.isRootPage) {
      window.MIP_SHELL_CONFIG = newShellConfig.routes
      window.MIP_PAGE_META_CACHE = Object.create(null)
      page.notifyRootPage({
        type: 'set-mip-shell-config',
        data: {
          shellConfig: newShellConfig.routes,
          update: true
        }
      })
    }
  }

  /**
   * find route.meta by pageId
   *
   * @param {string} pageId pageId
   * @return {Object} meta object
   */
  findMetaByPageId (pageId) {
    let target
    if (!page.isRootPage && !page.isCrossOrigin) {
      target = window.parent
    } else {
      target = window
    }

    if (target.MIP_PAGE_META_CACHE[pageId]) {
      return target.MIP_PAGE_META_CACHE[pageId]
    } else {
      for (let i = 0; i < target.MIP_SHELL_CONFIG.length; i++) {
        let route = target.MIP_SHELL_CONFIG[i]
        if (route.regexp.test(pageId)) {
          target.MIP_PAGE_META_CACHE[pageId] = route.meta
          return route.meta
        }
      }
    }

    console.warn('Cannot find MIP Shell Config for current page. Use default instead.')
    return Object.assign({}, DEFAULT_SHELL_CONFIG)
  }

  // ===================== Interfaces =====================
  processShellConfig (shellConfig) {
    // Change shell config
    // E.g. `routeConfig.header.buttonGroup = []` forces empty buttons
  }

  handleShellCustomButton (buttonName) {
    // Handle click on custom button
    // The only param `butonName` equals attribute values of `data-button-name`
    // E.g. click on `<div mip-header-btn data-button-name="hello"></div>` will pass `'hello'` as buttonName
  }

  renderOtherParts () {
    // Render other shell parts (except header)
    // Use `this.currentPageMeta` to get page config
    // E.g. footer, sidebar
  }

  updateOtherParts () {
    // Update other shell parts (except header)
    // Use `this.currentPageMeta` to get page config
    // E.g. footer, sidebar
  }

  showHeaderCloseButton () {
    // Whether show close button in header
    // Only effective when window.MIP.standalone = false
    return true
  }
}

export default MipShell
