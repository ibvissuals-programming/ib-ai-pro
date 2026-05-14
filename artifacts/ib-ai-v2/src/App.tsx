import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import ChatApp from "@/pages/ChatApp";
import Landing from "@/pages/Landing";
import NotFound from "@/pages/not-found";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { isAuthenticated } from "@/auth/authService";

function Router() {
  return (
    <Switch>
      {/* Root: show marketing landing for unauthenticated users,
          redirect authenticated users directly to /chat */}
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
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
