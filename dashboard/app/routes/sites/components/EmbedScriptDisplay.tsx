import React, { useState, useEffect } from 'react';
import { Link } from 'react-router'; // Import from react-router v7
import { useApiClient } from '~/lib/api';
import { Button } from '~/components/ui/button';
import { toast } from 'sonner';
import { Copy } from 'lucide-react'; // Icon for copy button

// Assuming a Site type exists, potentially imported from a shared types file or defined here
interface Site {
  site_id: string;
  owner_sub: string;
  domains: string[]; // Example, adjust if needed
  compliance_level: 'yes' | 'maybe' | 'no';
  // Add other relevant site fields if necessary
}


interface EmbedScriptDisplayProps {
  siteId: string;
}

export function EmbedScriptDisplay({ siteId }: EmbedScriptDisplayProps) {
  const { get } = useApiClient();
  const [siteData, setSiteData] = useState<Site | null>(null); // State for full site data
  const [scriptTag, setScriptTag] = useState<string | null>(null); // State for the generated script tag
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Effect 1: Fetch site data
  useEffect(() => {
    const fetchSiteData = async () => {
      if (!siteId) return;

      setIsLoading(true);
      setError(null);
      setSiteData(null); // Clear previous site data
      setScriptTag(null); // Clear previous script tag

      try {
        const data = await get<Site>(`/api/sites/${siteId}`);
        setSiteData(data);
      } catch (err: any) {
        console.error("Failed to fetch site data:", err);
        const errorMessage = err.message || 'Failed to load site settings.';
        setError(errorMessage);
        toast.error(errorMessage);
      } finally {
        // Loading state will be set to false after script generation effect finishes
      }
    };

    fetchSiteData();
  }, [get, siteId]);

  // Effect 2: Generate script tag when site data is available
  useEffect(() => {
    if (siteData) {
      try {
        const cdnUrl = import.meta.env.VITE_EMBED_SCRIPT_CDN_URL;
        if (!cdnUrl) {
          throw new Error("Embed script CDN URL is not configured.");
        }

        let filename: string;
        let level: string;

        switch (siteData.compliance_level) {
          case 'yes':
            filename = 'topup-basic.min.js';
            level = 'basic';
            break;
          case 'no':
            filename = 'topup-full.min.js';
            level = 'full';
            break;
          case 'maybe':
          default: // Default to enhanced if level is missing or unexpected
            filename = 'topup-enhanced.min.js';
            level = 'enhanced';
            break;
        }

        const generatedTag = `<script defer data-site="${siteData.site_id}" data-level="${level}" src="${cdnUrl}/${filename}"></script>`;
        setScriptTag(generatedTag);
        setError(null); // Clear any previous errors if script generation succeeds
      } catch (err: any) {
         console.error("Failed to generate script tag:", err);
         const errorMessage = err.message || 'Failed to generate embed script.';
         setError(errorMessage);
         toast.error(errorMessage);
         setScriptTag(null); // Ensure no stale script tag is shown
      } finally {
         setIsLoading(false); // Set loading false after attempting to generate script
      }
    } else if (!isLoading && !error) {
        // Handle case where siteData is null after loading finishes without error (shouldn't normally happen)
        setIsLoading(false);
    }
  }, [siteData, isLoading, error]); // Rerun when siteData changes or loading/error state resolves


  const copyToClipboard = () => {
    if (scriptTag) {
      navigator.clipboard.writeText(scriptTag)
        .then(() => {
          toast.success("Script copied to clipboard!");
        })
        .catch(err => {
          console.error('Failed to copy script: ', err);
          toast.error("Failed to copy script.");
        });
    }
  };

  return (
    <div className="space-y-4">
      {isLoading && <p>Loading script...</p>}
      {error && <p className="text-red-500">{error}</p>}
      {scriptTag && !isLoading && !error && ( // Only show if scriptTag exists, not loading, and no error
        <>
          <div className="relative rounded-md bg-muted p-4 font-mono text-sm overflow-x-auto">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 h-7 w-7"
              onClick={copyToClipboard}
              aria-label="Copy script to clipboard"
            >
              <Copy className="h-4 w-4" />
            </Button>
            <pre><code>{scriptTag}</code></pre>
          </div>
          <p className="text-sm text-muted-foreground">
            Copy and paste this script into the {'<head>'} section of your website HTML.
          </p>
          {/* Add the link to manual integration docs */}
          <p className="text-sm text-muted-foreground mt-2">
            Need more control? See the{' '}
            <Link to="/docs/installation" className="underline hover:text-primary">
              manual integration instructions
            </Link>.
          </p>
        </>
      )}
    </div>
  );
}