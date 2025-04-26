import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useNavigate } from 'react-router';
import { useApiClient } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea'; // For JSON fields
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
  }, { message: "Allowed domains must be a valid JSON array of strings (e.g., [\"example.com\", \"www.example.com\"])" }),
  // Add allowed_fields if needed for creation, otherwise omit or make optional
  // allowed_fields: z.string().refine(... similar validation ...),
});

type FormData = z.infer<typeof formSchema>;

export function CreateSiteForm() {
  const { post } = useApiClient();
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      allowed_domains: "[]", // Default to empty JSON array string
      // allowed_fields: "[]",
    },
  });

  async function onSubmit(values: FormData) {
    setIsSubmitting(true);
    try {
      // The schema ensures allowed_domains is a valid JSON string already
      const newSite = await post('/api/sites', {
        name: values.name,
        allowed_domains: values.allowed_domains,
        // allowed_fields: values.allowed_fields, // Include if part of the schema/API
      });
      toast.success(`Site "${values.name}" created successfully!`);
      // Navigate to the new site's detail page or back to the list
      // Assuming the API returns the new site object with its ID
      if (newSite?.site_id) {
        navigate(`/sites/${newSite.site_id}`);
      } else {
        navigate('/sites'); // Fallback to list if ID isn't returned
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
              <FormLabel>Allowed Domains (JSON Array)</FormLabel>
              <FormControl>
                {/* Using Textarea for easier multi-line JSON editing */}
                <Textarea
                  placeholder='["example.com", "www.example.com"]'
                  rows={3}
                  {...field}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormDescription>
                Enter the domains where the tracking script will be allowed to run, as a JSON array of strings.
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