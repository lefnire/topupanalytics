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
  const [isScriptLoaded, setIsScriptLoaded] = useState(false); // State to track script loading

  useEffect(() => {
    const scriptId = 'topup-embed-script';
    // Check if the script already exists to avoid duplicates during HMR or strict mode double-invocation
    let existingScript = document.getElementById(scriptId);
    if (existingScript) {
      console.log('TopUp script already present, skipping injection.');
      // Optionally, you might want to ensure attributes are correct if script exists
      // but this basic check prevents duplicate script tags.
    } else {
      const script = document.createElement('script');
      script.id = scriptId; // Add an ID for easy removal
      script.src = '/topup-enhanced.min.js'; // Load the dynamically generated script
      script.defer = true;
      script.setAttribute('data-site', '01JSTZ5PKC8T3NE2RH0ZYWJWM3'); // Site ID from old injectScript
      script.setAttribute('data-level', 'enhanced'); // Specify the level

      // Add onload and onerror handlers BEFORE appending
      script.onload = () => {
        console.log('TopUp script loaded successfully.');
        setIsScriptLoaded(true);
      };
      script.onerror = () => {
        console.error('Failed to load TopUp script.');
        setError('Failed to load the analytics script.');
        // Consider setting isScriptLoaded to false or handling differently if needed
      };

      document.body.appendChild(script);
      console.log('TopUp script injected.');
    }

    // Cleanup function to remove the script when the component unmounts
    return () => {
      const scriptToRemove = document.getElementById(scriptId);
      if (scriptToRemove) {
        document.body.removeChild(scriptToRemove);
        console.log('TopUp script removed on unmount.');
        // Consider if cleaning window.topup is necessary or handled by the script itself
        // delete window.topup;
      }
    };
  }, []); // Empty dependency array ensures this runs only once on mount and cleans up on unmount

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
      <button
        onClick={handleSendEvent}
        disabled={!isScriptLoaded}
        style={{
          padding: '10px 15px',
          cursor: isScriptLoaded ? 'pointer' : 'not-allowed',
          opacity: isScriptLoaded ? 1 : 0.6
        }}
      >
        Send Test Event
      </button>
      {feedback && <p style={{ color: 'green', marginTop: '10px' }}>{feedback}</p>}
      {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
    </div>
  );
};

export default TestIngestRoute;
