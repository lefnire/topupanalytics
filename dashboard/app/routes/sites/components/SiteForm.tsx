import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useNavigate } from 'react-router';
import { useApiClient, type Site } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '../../../components/ui/form';
import { toast } from 'sonner';

// Unified Zod schema
const formSchema = z.object({
  name: z.string().min(2, { message: "Site name must be at least 2 characters." }),
  allowed_domains: z.string().optional(), // Accept string, parse in onSubmit
  compliance_level: z.enum(['yes', 'maybe', 'no']).optional(), // Optional for create, defaults handled in onSubmit/API
});

type FormData = z.infer<typeof formSchema>;

interface SiteFormProps {
  mode: 'create' | 'update';
  site?: Site; // Only provided in 'update' mode
  onSuccess?: (site: Site) => void; // Callback on successful create/update
  onCancel?: () => void; // Optional callback for cancelling
}

export function SiteForm({ mode, site, onSuccess, onCancel }: SiteFormProps) {
  const { post, put } = useApiClient();
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isUpdateMode = mode === 'update';

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: isUpdateMode ? site?.name || "" : "",
      allowed_domains: isUpdateMode && Array.isArray(site?.domains) ? site.domains.join('\n') : "",
      compliance_level: isUpdateMode ? site?.compliance_level || 'maybe' : 'maybe', // Default 'maybe' for create
    },
  });

   // Reset form if the site prop changes in update mode
   useEffect(() => {
    if (isUpdateMode && site) {
        form.reset({
            name: site.name || "",
            allowed_domains: Array.isArray(site.domains) ? site.domains.join('\n') : "",
            compliance_level: site.compliance_level || 'maybe',
        });
    } else if (!isUpdateMode) {
        // Reset for create mode if needed (e.g., opening modal again)
        form.reset({
            name: "",
            allowed_domains: "",
            compliance_level: 'maybe',
        });
    }
  }, [site, mode, form, isUpdateMode]); // Add mode and isUpdateMode dependencies


  async function onSubmit(values: FormData) {
    setIsSubmitting(true);
    const uniqueHostnames = new Set<string>();

    try {
      // Parse allowed_domains string into array of hostnames
      if (values.allowed_domains) {
        const lines = values.allowed_domains.split('\n');
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.length > 0) {
            try {
              // Prepend http:// if no protocol exists, for URL parser
              const urlString = trimmedLine.includes('://') ? trimmedLine : `http://${trimmedLine}`;
              const parsedUrl = new URL(urlString);
              if (parsedUrl.hostname) {
                  uniqueHostnames.add(parsedUrl.hostname);
              } else {
                // Handle cases where parsing might succeed but hostname is empty (should be rare)
                // Optionally show a specific error for this line?
                console.warn(`Could not extract hostname from: ${trimmedLine}`);
              }
            } catch (e) {
              // Handle invalid URL format - maybe show toast?
              console.warn(`Invalid domain/URL format skipped: ${trimmedLine}`, e);
              // Optionally, inform the user about the skipped line
              // toast.warning(`Skipped invalid domain entry: ${trimmedLine}`);
            }
          }
        }
      }

      const domainsArray = [...uniqueHostnames];

      // Prepare data for API
      const siteData = {
        name: values.name,
        domains: domainsArray,
        // Only send compliance_level if it's explicitly set or in update mode
        // Backend defaults to 'maybe' on create if not provided
        ...(values.compliance_level && { compliance_level: values.compliance_level }),
      };

      let resultSite: Site;

      if (isUpdateMode && site?.site_id) {
        // Update existing site
        resultSite = await put<Site>(`/api/sites/${site.site_id}`, siteData);
        toast.success(`Site "${values.name}" updated successfully!`);
      } else {
        // Create new site
        resultSite = await post<Site>('/api/sites', siteData);
        toast.success(`Site "${values.name}" created successfully!`);
      }

      // Call onSuccess callback if provided
      if (onSuccess && resultSite) {
        onSuccess(resultSite);
      } else if (!isUpdateMode && resultSite?.site_id) {
        // Default navigation for create mode if no callback
        navigate(`/sites/${resultSite.site_id}`);
      } else if (!isUpdateMode) {
         navigate('/sites'); // Fallback for create
      }

    } catch (error: any) {
      console.error(`Failed to ${mode} site:`, error);
      toast.error(`Failed to ${mode} site: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Site Name */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Site Name</FormLabel>
              <FormControl>
                <Input placeholder={isUpdateMode ? "" : "My Awesome Blog"} {...field} disabled={isSubmitting} />
              </FormControl>
              {!isUpdateMode && (
                <FormDescription>
                  A descriptive name for your website.
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Allowed Domains */}
        <FormField
          control={form.control}
          name="allowed_domains"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Allowed Domains</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="example.com&#10;www.example.com"
                  rows={3}
                  {...field}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormDescription>
                Enter each domain on a new line. The tracking script will only run on these domains.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Compliance Level Radio Group */}
        <FormField
          control={form.control}
          name="compliance_level"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <FormLabel>Compliance Level</FormLabel>
              <div className="space-y-3">
                {/* Yes Option */}
                <div className="flex items-start space-x-3">
                  <FormControl>
                    <input
                      type="radio"
                      {...field}
                      value="yes"
                      checked={field.value === 'yes'}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      id="compliance-yes"
                      className="form-radio h-4 w-4 text-indigo-600 transition duration-150 ease-in-out mt-1"
                    />
                  </FormControl>
                  <div className="flex flex-col">
                    <Label htmlFor="compliance-yes" className="font-medium">
                      Yes (Maximum Privacy)
                    </Label>
                    <FormDescription className="text-sm">
                      Collects only essential, anonymous data. Fields marked 'maybe' or 'no' are excluded. No cookie banner needed.
                    </FormDescription>
                  </div>
                </div>
                {/* Maybe Option */}
                <div className="flex items-start space-x-3">
                  <FormControl>
                    <input
                      type="radio"
                      {...field}
                      value="maybe"
                      checked={field.value === 'maybe'}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      id="compliance-maybe"
                      className="form-radio h-4 w-4 text-indigo-600 transition duration-150 ease-in-out mt-1"
                    />
                  </FormControl>
                   <div className="flex flex-col">
                    <Label htmlFor="compliance-maybe" className="font-medium">
                      Maybe (Balanced - Default)
                    </Label>
                    <FormDescription className="text-sm">
                      Collects essential data plus potentially identifying data using privacy-preserving techniques. Fields marked 'no' are excluded. Requires privacy policy + opt-out.
                    </FormDescription>
                  </div>
                </div>
                {/* No Option */}
                <div className="flex items-start space-x-3">
                  <FormControl>
                    <input
                      type="radio"
                      {...field}
                      value="no"
                      checked={field.value === 'no'}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      id="compliance-no"
                      className="form-radio h-4 w-4 text-indigo-600 transition duration-150 ease-in-out mt-1"
                    />
                  </FormControl>
                  <div className="flex flex-col">
                    <Label htmlFor="compliance-no" className="font-medium">
                      No (Full Data - Requires Consent)
                    </Label>
                    <FormDescription className="text-sm">
                      Collects all available data. <strong>Requires explicit user consent (cookie banner).</strong>
                    </FormDescription>
                  </div>
                </div>
              </div>
              <FormDescription className="pt-2">
                Note: Changing the compliance level only affects data collected going forward.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Submit/Cancel Buttons */}
        <div className="flex items-center space-x-2 pt-2">
            <Button type="submit" disabled={isSubmitting || (isUpdateMode && !form.formState.isDirty)}>
              {isSubmitting ? (isUpdateMode ? 'Saving...' : 'Creating...') : (isUpdateMode ? 'Save Changes' : 'Create Site')}
            </Button>
            {onCancel && (
                 <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                    Cancel
                 </Button>
            )}
        </div>
         {isUpdateMode && !form.formState.isDirty && !isSubmitting && (
            <p className="text-sm text-muted-foreground">No changes detected.</p>
        )}
      </form>
    </Form>
  );
}