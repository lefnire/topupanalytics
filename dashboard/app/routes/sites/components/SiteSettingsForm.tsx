import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
// import { loadStripe } from '@stripe/stripe-js'; // Removed as Stripe checkout logic is no longer in this form
import { useApiClient, type Site } from '../../../lib/api';
import { initialEventsSchema } from '../../../../../functions/analytics/schema'; // Import the schema
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
  allowed_domains: z.string().optional(), // Accept string, parse in onSubmit
  allowed_fields: z.array(z.string()).optional(), // Expect an array of strings for checkboxes
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
      // Join array into newline-separated string for textarea
      allowed_domains: Array.isArray(site.allowed_domains) ? site.allowed_domains.join('\n') : "",
      // Use the array directly, default to empty array if null/undefined
      allowed_fields: Array.isArray(site.allowed_fields) ? site.allowed_fields : [],
      is_active: site.is_active ?? true, // Default to true if undefined/null
    },
  });

   // Reset form if the site prop changes (e.g., navigating between sites)
   useEffect(() => {
    form.reset({
      name: site.name || "",
      // Join array into newline-separated string for textarea
      allowed_domains: Array.isArray(site.allowed_domains) ? site.allowed_domains.join('\n') : "",
       // Use the array directly, default to empty array if null/undefined
      allowed_fields: Array.isArray(site.allowed_fields) ? site.allowed_fields : [],
      is_active: site.is_active ?? true,
    });
  }, [site, form]);


  async function onSubmit(values: FormData) {
    setIsSubmitting(true);
    try {
      // Parse allowed_domains string into array
      const domainsArray = values.allowed_domains
        ? values.allowed_domains.split('\n').map(d => d.trim()).filter(d => d.length > 0)
        : [];

      // Prepare data for API (using 'domains' key)
      const updatedSiteData = {
        name: values.name,
        domains: domainsArray, // Use parsed array and correct key
        allowed_fields: values.allowed_fields || [], // Send the array directly
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
        {/* Allowed Fields Checkboxes */}
        <FormField
          control={form.control}
          name="allowed_fields"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Allowed Data Fields</FormLabel>
              <FormDescription>
                Select the URL parameters or custom event data fields you want to collect.
              </FormDescription>
              <div className="space-y-2 pt-2">
                {initialEventsSchema.map((schemaField) => (
                  <FormField
                    key={schemaField.name}
                    control={form.control}
                    name="allowed_fields"
                    render={({ field: checkboxField }) => { // Rename inner field to avoid conflict
                      return (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={checkboxField.value?.includes(schemaField.name)}
                              onCheckedChange={(checked) => {
                                return checked
                                  ? checkboxField.onChange([...(checkboxField.value || []), schemaField.name])
                                  : checkboxField.onChange(
                                      (checkboxField.value || []).filter(
                                        (value) => value !== schemaField.name
                                      )
                                    );
                              }}
                              disabled={isSubmitting}
                            />
                          </FormControl>
                          <FormLabel className="font-normal">
                            {schemaField.name}
                          </FormLabel>
                        </FormItem>
                      );
                    }}
                  />
                ))}
              </div>
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