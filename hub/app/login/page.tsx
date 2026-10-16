import { LoginForm } from "./form";

export const metadata = { title: "Sign in - Claude Usage Hub" };

export default function LoginPage() {
  return (
    <main className="wrap">
      <div className="card login">
        <h1>Claude Usage Hub</h1>
        <p className="muted">Enter your hub token to view the dashboard.</p>
        <LoginForm />
      </div>
    </main>
  );
}
