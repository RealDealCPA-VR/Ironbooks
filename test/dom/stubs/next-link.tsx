/** next/link for the DOM tests: a plain <a> whose click goes through the stub router. */
import * as React from 'react';
import { useRouter } from './next-navigation';

type Props = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string | { pathname?: string }; prefetch?: boolean };

const Link = React.forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _p, onClick, ...rest }, ref) {
  const router = useRouter();
  const to = typeof href === 'string' ? href : (href.pathname ?? '/');
  return (
    <a
      ref={ref}
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        router.push(to);
      }}
    />
  );
});

export default Link;
