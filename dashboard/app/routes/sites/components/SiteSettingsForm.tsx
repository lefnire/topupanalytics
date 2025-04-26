import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
// import { loadStripe } from '@stripe/stripe-js'; // Removed as Stripe checkout logic is no longer in this form
import { useApiClient, type Site } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea';
import { Checkbox } from '../../../components/ui/checkbox'; // Need to add this
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '../../../components/ui/form';
import { toast } from 'sonner';

// Zod schema for validation
const formSchema = z.object({
  name: z.string().min(2, { message: "Site name must be at least 2 characters." }),
  allowed_domains: z.string().refine((val) => {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) && parsed.every(item => typeof item === 'string');
    } catch (e) {
      return false;
    }
  }, { message: "Allowed domains must be a valid JSON array of strings." }),
  allowed_fields: z.string().refine((val) => { // Assuming allowed_fields is also a JSON string array
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) && parsed.every(item => typeof item === 'string');
    } catch (e) {
      return false;
    }
  }, { message: "Allowed fields must be a valid JSON array of strings (e.g., [\"utm_source\", \"referrer\"])" }),
  is_active: z.boolean(),
});

type FormData = z.infer<typeof formSchema>;

interface SiteSettingsFormProps {
  site: Site;
  onUpdate?: (updatedSite: Site) => void; // Optional callback after successful update
}

export function SiteSettingsForm({ site, onUpdate }: SiteSettingsFormProps) {
  const { put } = useApiClient(); // Remove 'post' if only used for upgrade
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Remove isUpgrading state: const [isUpgrading, setIsUpgrading] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    // Initialize with current site values
    defaultValues: {
      name: site.name || "",
      allowed_domains: site.allowed_domains || "[]",
      allowed_fields: site.allowed_fields || "[]", // Initialize allowed_fields
      is_active: site.is_active ?? true, // Default to true if undefined/null
    },
  });

   // Reset form if the site prop changes (e.g., navigating between sites)
   useEffect(() => {
    form.reset({
      name: site.name || "",
      allowed_domains: site.allowed_domains || "[]",
      allowed_fields: site.allowed_fields || "[]",
      is_active: site.is_active ?? true,
    });
  }, [site, form]);


  async function onSubmit(values: FormData) {
    setIsSubmitting(true);
    try {
      // Schema ensures JSON fields are valid strings
      const updatedSiteData = {
        name: values.name,
        allowed_domains: values.allowed_domains,
        allowed_fields: values.allowed_fields,
        is_active: values.is_active,
      };

      const updatedSite = await put<Site>(`/api/sites/${site.site_id}`, updatedSiteData);
      toast.success(`Site "${values.name}" updated successfully!`);
      if (onUpdate && updatedSite) {
         onUpdate(updatedSite); // Notify parent component if needed
      }
       // Optionally reset form to show updated values, though useEffect handles this if site prop updates
       // form.reset(values); // Reset with the submitted values
    } catch (error: any) {
      console.error("Failed to update site:", error);
      toast.error(`Failed to update site: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  }

   // Removed handleUpgradeClick function related to Stripe Checkout

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* --- Move handler above return --- */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Site Name</FormLabel>
              <FormControl>
                <Input {...field} disabled={isSubmitting} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="allowed_domains"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Allowed Domains (JSON Array)</FormLabel>
              <FormControl>
                <Textarea rows={3} {...field} disabled={isSubmitting} />
              </FormControl>
              <FormDescription>
                Domains where the tracking script can run (JSON array of strings).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
         <FormField
          control={form.control}
          name="allowed_fields"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Allowed GDPR Fields (JSON Array)</FormLabel>
              <FormControl>
                <Textarea
                    placeholder='["utm_source", "referrer", "custom_event"]'
                    rows={3}
                    {...field}
                    disabled={isSubmitting}
                 />
              </FormControl>
              <FormDescription>
                URL parameters or custom event fields allowed for collection (JSON array of strings).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
         <FormField
          control={form.control}
          name="is_active"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
               <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>
                  Active Status
                </FormLabel>
                <FormDescription>
                  Enable or disable tracking for this site. Inactive sites will not collect data.
                </FormDescription>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex items-center space-x-2">
            <Button type="submit" disabled={isSubmitting || !form.formState.isDirty}>
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
            {/* Removed Upgrade Button */}
        </div>
         {!form.formState.isDirty && !isSubmitting && (
            <p className="text-sm text-muted-foreground">No changes detected.</p>
        )}
      </form>
    </Form>
  );
}