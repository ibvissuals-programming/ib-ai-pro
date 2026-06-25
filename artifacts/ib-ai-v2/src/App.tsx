import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import ChatApp from "@/pages/ChatApp";
import Landing from "@/pages/Landing";
import ImageTools from "@/pages/ImageTools";
import VoiceStudio from "@/pages/VoiceStudio";
import VideoStudio from "@/pages/VideoStudio";
import Library from "@/pages/Library";
import CeoDashboard from "@/pages/CeoDashboard";
import NotFound from "@/pages/not-found";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { CeoRoute } from "@/auth/CeoRoute";
import { isAuthenticated } from "@/auth/authService";
import { ThemeProvider } from "@/contexts/ThemeContext";

function Router() {
  return (
    <Switch>
      <Route path="/">
        {isAuthenticated() ? <Redirect to="/chat" /> : <Landing />}
      </Route>
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/chat">
        <ProtectedRoute>
          <ChatApp />
        </ProtectedRoute>
      </Route>
      <Route path="/image-tools">
        <ProtectedRoute>
          <ImageTools />
        </ProtectedRoute>
      </Route>
      <Route path="/library">
        <ProtectedRoute>
          <Library />
        </ProtectedRoute>
      </Route>
      <Route path="/voice">
        <Redirect to="/chat" />
      </Route>
      <Route path="/video">
        <ProtectedRoute>
          <VideoStudio />
        </ProtectedRoute>
      </Route>
      <Route path="/ceo/dashboard">
        <CeoRoute>
          <CeoDashboard />
        </CeoRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={(import.meta.env.BASE_URL ?? '/').replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
