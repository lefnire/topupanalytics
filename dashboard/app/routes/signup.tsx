import { useState } from 'react';
import { useNavigate } from 'react-router';
import { signUp } from '@aws-amplify/auth';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Toaster, toast } from 'sonner';

export default function SignUpPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSignUp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const { nextStep } = await signUp({
        username: email,
        password: password,
        options: {
          userAttributes: {
            email: email, // Cognito often requires email as a standard attribute
          },
          // autoSignIn: true // Optional: Sign in the user automatically after confirmation
        }
      });

      if (nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
         toast.info('Confirmation code sent to your email.');
         // Pass email to confirmation page for pre-filling
         navigate(`/confirm-signup?email=${encodeURIComponent(email)}`);
      } else {
         // Handle other potential next steps if needed (e.g., DONE)
         toast.success('Sign up successful! Please log in.');
         navigate('/login');
      }

    } catch (error: any) {
      console.error('Error signing up:', error);
      toast.error(error.message || 'Sign up failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Sign Up</CardTitle>
          <CardDescription>Enter your information to create an account.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSignUp}>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="m@example.com"
                required
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                required
                value={confirmPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                disabled={loading}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing up...' : 'Sign Up'}
            </Button>
             <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
              Already have an account?{' '}
              <a href="/login" className="underline">
                Login
              </a>
            </p>
          </CardFooter>
        </form>
      </Card>
      <Toaster richColors />
    </div>
  );
}