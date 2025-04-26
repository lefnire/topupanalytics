import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { confirmSignUp, resendSignUpCode } from '@aws-amplify/auth';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Toaster, toast } from 'sonner';

export default function ConfirmSignUpPage() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Pre-fill email from query parameter if available
    const emailFromQuery = searchParams.get('email');
    if (emailFromQuery) {
      setEmail(emailFromQuery);
    }
  }, [searchParams]);

  const handleConfirmSignUp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email) {
        toast.error("Email is required to confirm sign up.");
        return;
    }
    setLoading(true);
    try {
      await confirmSignUp({ username: email, confirmationCode });
      toast.success('Account confirmed successfully! Please log in.');
      navigate('/login');
    } catch (error: any) {
      console.error('Error confirming sign up:', error);
      toast.error(error.message || 'Confirmation failed. Please check the code or request a new one.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!email) {
        toast.error("Email is required to resend the code.");
        return;
    }
    setResendLoading(true);
    try {
        await resendSignUpCode({ username: email });
        toast.info('Confirmation code resent successfully.');
    } catch (error: any) {
        console.error('Error resending code:', error);
        toast.error(error.message || 'Failed to resend code.');
    } finally {
        setResendLoading(false);
    }
  };


  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Confirm Sign Up</CardTitle>
          <CardDescription>Enter the confirmation code sent to your email.</CardDescription>
        </CardHeader>
        <form onSubmit={handleConfirmSignUp}>
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
                disabled={loading || resendLoading || searchParams.get('email') !== null} // Disable if pre-filled
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirmationCode">Confirmation Code</Label>
              <Input
                id="confirmationCode"
                type="text"
                placeholder="123456"
                required
                value={confirmationCode}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmationCode(e.target.value)}
                disabled={loading || resendLoading}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full" disabled={loading || resendLoading}>
              {loading ? 'Confirming...' : 'Confirm Account'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleResendCode}
              disabled={loading || resendLoading}
            >
              {resendLoading ? 'Resending...' : 'Resend Code'}
            </Button>
             <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
              Already confirmed?{' '}
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