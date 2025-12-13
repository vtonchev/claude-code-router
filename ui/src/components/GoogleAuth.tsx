import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { KeyRound, CheckCircle2, XCircle, Loader2, RefreshCw, Pencil } from "lucide-react";

interface GoogleAuthStatus {
  hasCredentials: boolean;
  hasRefreshToken: boolean;
  hasClientId: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface GoogleAuthProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast: (message: string, type: 'success' | 'error' | 'warning') => void;
}

export function GoogleAuth({ open, onOpenChange, showToast }: GoogleAuthProps) {
  const [status, setStatus] = useState<GoogleAuthStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (open) {
      checkStatus();
    }
  }, [open]);

  const checkStatus = async () => {
    try {
      const result = await api.get<GoogleAuthStatus>('/google-auth/status');
      setStatus(result);
      // Prepopulate form fields with saved values
      if (result.clientId) {
        setClientId(result.clientId);
      }
      if (result.clientSecret) {
        setClientSecret(result.clientSecret);
      }
      if (result.redirectUri) {
        setRedirectUri(result.redirectUri);
      }
    } catch (error) {
      console.error('Failed to check Google auth status:', error);
    }
  };

  const startEditing = () => {
    // When editing, prepopulate with current values
    if (status?.clientId) {
      setClientId(status.clientId);
    }
    if (status?.clientSecret) {
      setClientSecret(status.clientSecret);
    }
    if (status?.redirectUri) {
      setRedirectUri(status.redirectUri);
    }
    setIsEditing(true);
  };

  const saveCredentials = async () => {
    if (!clientId || !clientSecret) {
      showToast('Client ID and Secret are required', 'error');
      return;
    }
    if (!redirectUri) {
      showToast('Callback URL is required', 'error');
      return;
    }

    setIsLoading(true);
    try {
      await api.post('/google-auth/credentials', {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      });
      showToast('Credentials saved successfully', 'success');
      await checkStatus();
      setIsEditing(false);
    } catch (error) {
      showToast('Failed to save credentials: ' + (error as Error).message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const startOAuth = async () => {
    setIsLoading(true);
    try {
      const result = await api.get<{ authUrl: string; redirectUri: string }>('/google-auth/start');

      window.open(result.authUrl, '_blank', 'width=600,height=700');

      showToast('Complete authentication in the popup window', 'success');

      const pollInterval = setInterval(async () => {
        const newStatus = await api.get<GoogleAuthStatus>('/google-auth/status');
        if (newStatus.hasRefreshToken) {
          clearInterval(pollInterval);
          setStatus(newStatus);
          showToast('Authentication successful!', 'success');
        }
      }, 2000);

      setTimeout(() => clearInterval(pollInterval), 60 * 1000);

    } catch (error) {
      showToast('Failed to start OAuth: ' + (error as Error).message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const showEditForm = !status?.hasClientId || isEditing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Google OAuth Setup
          </DialogTitle>
          <DialogDescription>
            Configure Google OAuth for the Gemini interceptor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Status Section */}
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm">Status</h4>
              <div className="flex gap-1">
                {status?.hasClientId && !isEditing && (
                  <Button variant="ghost" size="sm" onClick={startEditing} title="Edit credentials">
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={checkStatus}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {status?.hasClientId ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              <span>Client credentials</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {status?.hasRefreshToken ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              <span>Refresh token</span>
            </div>
            {status?.clientId && !isEditing && (
              <div className="text-xs text-muted-foreground mt-2">
                Client: <code className="bg-muted px-1 rounded">{status.clientId.substring(0, 20)}...</code>
              </div>
            )}
            {status?.redirectUri && !isEditing && (
              <div className="text-xs text-muted-foreground">
                Callback: <code className="bg-muted px-1 rounded">{status.redirectUri}</code>
              </div>
            )}
          </div>

          {/* Credentials Form */}
          {showEditForm && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground font-medium">
                {isEditing ? 'Edit Credentials' : 'Enter OAuth Credentials'}
              </div>

              <div className="space-y-2">
                <Label htmlFor="clientId">Client ID</Label>
                <Input
                  id="clientId"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxx.apps.googleusercontent.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="clientSecret">Client Secret</Label>
                <Input
                  id="clientSecret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-xxxx"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="redirectUri">Callback URL</Label>
                <Input
                  id="redirectUri"
                  value={redirectUri}
                  onChange={(e) => setRedirectUri(e.target.value)}
                  placeholder="http://localhost:39101/oauth-callback"
                />
                <p className="text-xs text-muted-foreground">
                  Must match the redirect URI in your Google OAuth client
                </p>
              </div>

              <div className="flex gap-2">
                <Button onClick={saveCredentials} disabled={isLoading} className="flex-1">
                  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Credentials
                </Button>
                {isEditing && (
                  <Button variant="outline" onClick={() => setIsEditing(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* OAuth Button */}
          {status?.hasClientId && !isEditing && !status?.hasRefreshToken && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Click below to authenticate with Google.
              </p>
              <Button onClick={startOAuth} disabled={isLoading} className="w-full">
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign in with Google
              </Button>
            </div>
          )}

          {/* Success State */}
          {status?.hasRefreshToken && !isEditing && (
            <div className="text-center py-4">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-2" />
              <p className="font-medium">You're authenticated!</p>
              <p className="text-sm text-muted-foreground">
                The Gemini interceptor will use your Google credentials.
              </p>
              <Button variant="outline" onClick={startOAuth} className="mt-4">
                Re-authenticate
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
