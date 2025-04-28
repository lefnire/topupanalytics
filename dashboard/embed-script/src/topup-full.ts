// Full embed script - Initializes core analytics + all features
import './core';

// Placeholder for enhanced features (e.g., automatic event tracking)
console.log("Topup Analytics Full script loaded.");

// Example: Add automatic click tracking (conceptual)
// document.addEventListener('click', (event) => {
//   if (window._topupAnalytics && window._topupAnalytics.track) {
//     // Basic example: track clicks on buttons
//     if ((event.target as HTMLElement).tagName === 'BUTTON') {
//       window._topupAnalytics.track('click', { element: 'button', text: (event.target as HTMLElement).innerText });
//     }
//   }
// }, true); // Use capture phase

// Placeholder for full features (e.g., session recording, heatmaps - conceptual)
// function initializeSessionRecording() {
//   console.log("Initializing session recording (placeholder)...");
//   // Add session recording library initialization here
// }
//
// function initializeHeatmaps() {
//   console.log("Initializing heatmaps (placeholder)...");
//   // Add heatmap library initialization here
// }
//
// // Initialize full features after core init (or based on site settings)
// if (window._topupAnalytics?._siteId) {
//   initializeSessionRecording();
//   initializeHeatmaps();
// } else {
//   // Queue initialization if core isn't ready? Or handle differently.
//   const originalInit = window._topupAnalytics?.init;
//   if (originalInit && window._topupAnalytics) {
//       window._topupAnalytics.init = (siteId: string) => {
//           originalInit(siteId);
//           initializeSessionRecording();
//           initializeHeatmaps();
//       }
//   }
// }