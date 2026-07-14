import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from 'codra';

export const RepositoryCard = () => (
  <Card style={{ maxWidth: 380 }}>
    <CardHeader>
      <CardTitle>acme/web-app</CardTitle>
      <CardDescription>Automatic AI review runs on every pull request.</CardDescription>
    </CardHeader>
    <CardContent>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Badge variant="success">Connected</Badge>
        <Badge variant="secondary">main</Badge>
        <Badge variant="info">Sonnet 4.5</Badge>
      </div>
    </CardContent>
    <CardFooter style={{ gap: 8 }}>
      <Button size="sm">Configure</Button>
      <Button size="sm" variant="ghost">
        Disable
      </Button>
    </CardFooter>
  </Card>
);
