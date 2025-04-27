import React, { useState, useEffect } from 'react';
import { useApiClient } from '~/lib/api';
import { Button } from '~/components/ui/button';
import { toast } from 'sonner';
import { Copy } from 'lucide-react'; // Icon for copy button

interface EmbedScriptDisplayProps {
  siteId: string;
}

export function EmbedScriptDisplay({ siteId }: EmbedScriptDisplayProps) {
  const { get } = useApiClient();
  const [script, setScript] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchScript = async () => {
      if (!siteId) return; // Should not happen if called correctly

      setIsLoading(true);
      setError(null);
      setScript(null); // Clear previous script

      try {
        // Use the API client, expecting text response
        const scriptContent = await get<string>(`/api/sites/${siteId}/script`);
        setScript(scriptContent);
      } catch (err: any) {
        console.error("Failed to fetch embed script:", err);
        setError(err.message || 'Failed to load embed script.');
        toast.error(err.message || 'Failed to load embed script.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchScript();
  }, [get, siteId]);

  const copyToClipboard = () => {
    if (script) {
      navigator.clipboard.writeText(script)
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
      {script && (
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
            <pre><code>{script}</code></pre>
          </div>
          <p className="text-sm text-muted-foreground">
            Copy and paste this script into the {'<head>'} section of your website HTML.
          </p>
        </>
      )}
    </div>
  );
}