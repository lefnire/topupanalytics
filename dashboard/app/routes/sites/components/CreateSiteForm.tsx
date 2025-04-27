import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useNavigate } from 'react-router';
import { useApiClient, type Site } from '../../../lib/api'; // Import Site type
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea'; // For JSON fields
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '../../../components/ui/form';
import { toast } from 'sonner';

// Zod schema for validation
const formSchema = z.object({
  name: z.string().min(2, { message: "Site name must be at least 2 characters." }),
  allowed_domains: z.string().optional(), // Accept a string, parsing happens in onSubmit
  // Add allowed_fields if needed for creation, otherwise omit or make optional
  // allowed_fields: z.string().refine(... similar validation ...),
});

type FormData = z.infer<typeof formSchema>;

interface CreateSiteFormProps {
  onSuccess?: (newSite: Site) => void; // Optional success callback
}

export function CreateSiteForm({ onSuccess }: CreateSiteFormProps) {
  const { post } = useApiClient();
  const navigate = useNavigate(); // Keep navigate for fallback if onSuccess is not provided
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      allowed_domains: "", // Default to empty string
      // allowed_fields: "[]",
    },
  });

  async function onSubmit(values: FormData) {
    setIsSubmitting(true);
    try {
      // Parse the newline-delimited string into an array and use the correct key 'domains'
      const domainsArray = values.allowed_domains
        ? values.allowed_domains.split('\n').map(d => d.trim()).filter(d => d.length > 0)
        : []; // Handle empty/undefined input
      const newSite: Site = await post('/api/sites', { // Add type annotation
        name: values.name, // Send name
        domains: domainsArray, // Send parsed array
        // allowed_fields: [], // Send empty array if needed by API on creation
      });
      toast.success(`Site "${values.name}" created successfully!`);
      // If an onSuccess callback is provided, call it instead of navigating
      if (onSuccess) {
        onSuccess(newSite);
      } else if (newSite?.site_id) {
        // Default behavior: navigate if no callback provided
        navigate(`/sites/${newSite.site_id}`);
      } else {
        navigate('/sites'); // Fallback
      }
    } catch (error: any) {
      console.error("Failed to create site:", error);
      toast.error(`Failed to create site: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Site Name</FormLabel>
              <FormControl>
                <Input placeholder="My Awesome Blog" {...field} disabled={isSubmitting} />
              </FormControl>
              <FormDescription>
                A descriptive name for your website.
              </FormDescription>
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
                  placeholder="example.com&#10;www.example.com" // Updated placeholder
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
        {/* Add FormField for allowed_fields here if needed */}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating...' : 'Create Site'}
        </Button>
      </form>
    </Form>
  );
}