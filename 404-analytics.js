window.dataLayer = window.dataLayer || []
window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments) }
window.gtag('js', new Date())
window.gtag('config', 'G-T30S2TK79K', { send_page_view: false })
window.gtag('event', 'page_view', {
  page_title: document.title,
  page_location: window.location.href,
  page_path: window.location.pathname,
})

const ads = document.createElement('script')
ads.async = true
ads.crossOrigin = 'anonymous'
ads.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3050978093233454'
ads.dataset.kluzarAds = 'true'
document.head.append(ads)
