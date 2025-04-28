import {memo, useEffect, useRef} from "react";
import {useLocation, useSearchParams} from "react-router";

const endpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;
console.log({endpoint})
const isServer = typeof window === 'undefined'

// set on first load; allow changing later. Just a tiny compute-saver (global var)
// for each action
let TRACK = isServer ? false : !window.localStorage.notrack

async function sendEvent(event: string, data: any) {
  if (!TRACK) { return; }
  const pathname = window.location.pathname
  fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
    event,
      pathname,
      session_id: sessionStorage.getItem('session_id'),
      ...data, // Include any event-specific data
      // No need to send userAgent as it's available in the request headers
    })
  })
}

export const clickAffiliate = (key: string) => () => {
  // console.log("affiliate")
  sendEvent('affiliate', { properties: { product: key }})
}

export const AnalyticsListener = memo(() => {
  const {pathname} = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  // It's calling twice sometimes for some reason
  const lastPathname = useRef("");

  useEffect(() => {
    const notrack = searchParams.get('notrack')
    if (notrack === null || notrack === undefined) { return; }
    TRACK = false;
    window.localStorage.setItem("notrack", "true")
  }, [searchParams])

  useEffect(() => {
    // handled in sendEvent, just skipping here to save compute
    if (!TRACK) { return; }
    // double-calling sometimes
    if (pathname === lastPathname.current) { return; }
    lastPathname.current = pathname;

    let data: any = { pathname }
    const is_initial_event = !sessionStorage.getItem('session_id')
    if (is_initial_event) {
      // generate random string
      const session_id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      sessionStorage.setItem("session_id", session_id)
      // Only keep properties that can't be reliably determined server-side
      // or that need to be consistent across requests
      data.is_initial_event = true;

      // Screen dimensions (more stable than viewport)
      data.screen_height = window.screen.height;
      data.screen_width = window.screen.width;

      // Initial referrer information (important for attribution)
      // WARNING: referer content can vary; may be identifying (Danger: 5/10)
      data.referer = document.referrer;
      // Language preference (Removed as it's often available server-side or less critical)

      let utmDeleted = false
      for (const k of ['utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term']) {
        const val = searchParams.get(k)
        if (val) {
          data[k] = val;
          searchParams.delete(k)
          utmDeleted = true
        }
      }
      if (utmDeleted) {
        setSearchParams(searchParams)
      }
    }
    sendEvent('page_view', data)
  }, [pathname])

  return null
})

// git-blame: google analytics
