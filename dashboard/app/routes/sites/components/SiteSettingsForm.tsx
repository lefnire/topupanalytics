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
import { Checkbox } from '../../../components/ui/checkbox';
// Removed incorrect RadioGroup import
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '../../../components/ui/form';
import { toast } from 'sonner';

// Zod schema for validation
const formSchema = z.object({
  name: z.string().min(2, { message: "Site name must be at least 2 characters." }),
  allowed_domains: z.string().optional(), // Accept string, parse in onSubmit
  compliance_level: z.enum(['yes', 'maybe', 'no'], { required_error: "Compliance level is required." }), // Updated compliance level
  is_active: z.boolean(),
});

// Infer the type directly, including the new field
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
      // Initialize compliance_level, default to 'enhanced' if not set
      compliance_level: site.compliance_level || 'maybe', // Default to 'maybe'
      is_active: site.is_active ?? true, // Default to true if undefined/null
    },
  });

   // Reset form if the site prop changes (e.g., navigating between sites)
   useEffect(() => {
    form.reset({
      name: site.name || "",
      // Join array into newline-separated string for textarea
      allowed_domains: Array.isArray(site.allowed_domains) ? site.allowed_domains.join('\n') : "",
      // Reset compliance_level, default to 'enhanced' if not set
      compliance_level: site.compliance_level || 'maybe', // Default to 'maybe'
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
        compliance_level: values.compliance_level, // Send the selected compliance level
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
        {/* Compliance Level Radio Group */}
        {/* Compliance Level Radio Group - Updated for yes/maybe/no */}
        <FormField
          control={form.control}
          name="compliance_level"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <FormLabel>Compliance Level</FormLabel>
              {/* Use standard HTML radio inputs */}
              <div className="space-y-3">
                {/* Yes Option */}
                <div className="flex items-start space-x-3"> {/* Changed to items-start for better alignment with multi-line descriptions */}
                  <FormControl>
                    <input
                      type="radio"
                      {...field}
                      value="yes"
                      checked={field.value === 'yes'}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      id="compliance-yes"
                      className="form-radio h-4 w-4 text-indigo-600 transition duration-150 ease-in-out mt-1" // Added mt-1 for alignment
                    />
                  </FormControl>
                  <div className="flex flex-col"> {/* Wrap label and description */}
                    <Label htmlFor="compliance-yes" className="font-medium"> {/* Use standard Label, slightly bolder */}
                      Yes (Maximum Privacy)
                    </Label>
                    <FormDescription className="text-sm"> {/* Removed pl-7, handled by flex container */}
                      Collects only essential, anonymous data (e.g., country, page path, device class). Fields marked 'maybe' or 'no' in the schema are excluded. No cookie banner needed.
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
                      Collects essential data plus potentially identifying data (e.g., city, browser version, screen size) using privacy-preserving techniques where applicable (like referer scrubbing). Fields marked 'no' are excluded. Requires privacy policy + opt-out.
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
                      Collects all available data defined in the schema, including potentially sensitive fields (e.g., device model, manufacturer). <strong>Requires explicit user consent (cookie banner).</strong>
                    </FormDescription>
                  </div>
                </div>
              </div>
              <FormDescription className="pt-2"> {/* Keep the general note */}
                Note: Changing the compliance level only affects data collected going forward. It does not alter historical data.
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