// Enhanced embed script - Initializes core analytics + potentially more features
import './core';

// Placeholder for enhanced features (e.g., automatic event tracking)
console.log("Topup Analytics Enhanced script loaded.");

// Example: Add automatic click tracking (conceptual)
// document.addEventListener('click', (event) => {
//   if (window._topupAnalytics && window._topupAnalytics.track) {
//     // Basic example: track clicks on buttons
//     if ((event.target as HTMLElement).tagName === 'BUTTON') {
//       window._topupAnalytics.track('click', { element: 'button', text: (event.target as HTMLElement).innerText });
//     }
//   }
// }, true); // Use capture phase