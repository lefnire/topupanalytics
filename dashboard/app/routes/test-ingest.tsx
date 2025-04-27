import React, {useState, useCallback, useEffect} from 'react';

// Assuming window.topup is globally available and configured
declare global {
  interface Window {
    topup?: {
      event: (name: string, payload?: Record<string, any>) => void;
      // Add other topup methods if needed
    };
  }
}

const TestIngestRoute: React.FC = () => {

  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    injectScript()
  }, [])

  const handleSendEvent = useCallback(() => {
    setFeedback(null); // Clear previous feedback
    setError(null); // Clear previous error

    // The site ID '01JSTPAD505QAGBCMBVRBPP6DP' should be automatically
    // associated by the globally loaded analytics script if it's configured
    // for this specific site ID on this page/environment.
    // We don't explicitly pass the site ID here, relying on the global setup.
    const eventName = 'test_dogfood_event';
    const payload = { source: 'dashboard-test-route' };

    try {
      if (window.topup && typeof window.topup.event === 'function') {
        console.log(`Sending event: ${eventName}`, payload);
        window.topup.event(eventName, payload);
        const successMessage = `Event '${eventName}' sent successfully!`;
        setFeedback(successMessage);
        console.log(successMessage);
      } else {
        throw new Error('window.topup.event is not available.');
      }
    } catch (err) {
      const errorMessage = `Error sending event: ${err instanceof Error ? err.message : String(err)}`;
      setError(errorMessage);
      console.error(errorMessage, err);
    }
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h1>Analytics Test Page</h1>
      <p>
        This page sends a test event (<code>test_dogfood_event</code>) associated with the site ID{' '}
        <code>01JSTPAD505QAGBCMBVRBPP6DP</code> using the global <code>window.topup.event</code> function.
      </p>
      <button onClick={handleSendEvent} style={{ padding: '10px 15px', cursor: 'pointer' }}>
        Send Test Event
      </button>
      {feedback && <p style={{ color: 'green', marginTop: '10px' }}>{feedback}</p>}
      {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
    </div>
  );
};

export default TestIngestRoute;

function injectScript() {
  (function() {
    if (window.topup) {
      console.warn('TopUp script already loaded.');
      return;
    }

    const siteId = '01JSTZ5PKC8T3NE2RH0ZYWJWM3';
    const ingestUrl = 'https://d214ciuro9isnp.cloudfront.net/api/event'; // Use the dynamically generated ingest URL

    // Simple session ID management using sessionStorage
    function getSessionId() {
      let sid = sessionStorage.getItem('topup_sid');
      let isNewSession = false;
      if (!sid) {
        sid = Date.now() + '-' + Math.random().toString(36).substring(2);
        sessionStorage.setItem('topup_sid', sid);
        isNewSession = true;
      }
      return { sessionId: sid, isNewSession: isNewSession };
    }

    // Function to extract basic UTM parameters
    function getUtmParams() {
      const params = new URLSearchParams(window.location.search);
      const utm = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(key => {
        if (params.has(key)) {
          utm[key] = params.get(key);
        }
      });
      return utm;
    }

    window.topup = {
      event: function(eventName, payload = {}) {
        try {
          const { sessionId, isNewSession } = getSessionId();
          const data = {
            site_id: siteId,
            session_id: sessionId,
            event: eventName,
            pathname: window.location.pathname,
            timestamp: new Date().toISOString(),
            properties: payload,
          };

          if (isNewSession) {
            data.is_initial_event = true;
            data.referer = document.referrer || null; // Use null if empty
            data.screen_width = window.screen.width;
            data.screen_height = window.screen.height;
            const utmParams = getUtmParams();
            if (Object.keys(utmParams).length > 0) {
              data.utm_params = utmParams; // Nest UTM params under a key
            }
          }

          // Use keepalive: true for reliability on page unload
          fetch(ingestUrl + '?site=' + siteId, { // Pass siteId in query param as well for potential routing/filtering
            method: 'POST',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' },
            keepalive: true
          }).catch(console.error); // Basic error handling

        } catch (error) {
          console.error('TopUp Error:', error);
        }
      }
    };

    // Track initial pageview automatically
    window.topup.event('pageview');

    console.log('TopUp Analytics Initialized for site: ' + siteId);

  })();
}