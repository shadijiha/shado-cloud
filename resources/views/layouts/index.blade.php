<!doctype html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <!-- CSRF Token -->
    <meta name="csrf-token" content="{{ csrf_token() }}">

    <title>{{ config('app.name', 'Laravel') }}</title>

    <!-- Scripts -->
    <script src="{{ asset('js/app.js') }}" defer></script>
    <script>
        const csrf_token = '{{ csrf_token() }}';
        const Routes = {
            index: "{{ route("index") }}",
            recent: "{{ route("index") }}",
            settings: "{{ route("settings")  }}",
            search: "{{ route("search") }}",
            createDir: "{{route("createDir")}}"
        };

        const CURRENT_PATH = '{{str_replace("\\", "\\\\", $path ?? "")}}';

        // Slid the Menu sidebar, onload, hover, leave
        window.addEventListener("load", function () {
            const checkBox = document.getElementById("check");
            const ClickCheckBox = () => checkBox.click()

            ClickCheckBox();

            document.getElementById("sidebar").addEventListener("mouseenter", function () {
                if (checkBox.checked === true)
                    ClickCheckBox();
            });
            document.getElementById("sidebar").addEventListener("mouseleave", function () {
                if (checkBox.checked === false)
                    ClickCheckBox();
            });
        });

        // Global functions
        const selectText = (containerid) => {
            if (document.selection) { // IE
                const range = document.body.createTextRange();
                range.moveToElementText(document.getElementById(containerid));
                range.select();
            } else if (window.getSelection) {
                const range = document.createRange();
                range.selectNode(document.getElementById(containerid));
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
            }
        }

        const mouse = {
            x: undefined,
            y: undefined
        }
        window.addEventListener("mousemove", function (e) {
            mouse.x = e.x;
            mouse.y = e.y;
        })
    </script>
@yield('scripts')

<!-- Fonts -->
    <link rel="dns-prefetch" href="//fonts.gstatic.com">
    <link href="https://fonts.googleapis.com/css?family=Nunito" rel="stylesheet">

    <!-- libs -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.1/css/all.min.css"
          integrity="sha512-+4zCK9k+qNFUR5X+cKL9EIR+ZOhtIloNl9GIKS57V1MyNsYpYcUrUeQc9vNfzsWfV28IaLL3i96P9sdNyeRssA=="
          crossorigin="anonymous"/>

    <!-- Styles -->
    <link href="{{ asset('css/app.css') }}" rel="stylesheet">

</head>
<body>
<div id="app">

    <input type="checkbox" id="check"/>
    <nav class="navbar navbar-expand-md navbar-dark header_bar shadow-sm">
        <div class="container">
            <label for="check">
                <i class="fas fa-bars" id="sidebar_btn"></i>
            </label>

            <a class="navbar-brand" href="{{ url('/') }}">
                {{ config('app.name', 'Laravel') }}
            </a>
            <button class="navbar-toggler" type="button" data-toggle="collapse"
                    data-target="#navbarSupportedContent"
                    aria-controls="navbarSupportedContent" aria-expanded="false"
                    aria-label="{{ __('Toggle navigation') }}">
                <span class="navbar-toggler-icon"></span>
            </button>

            {{-- @ReactComponent search bar begin --}}
            <div id="search_bar"></div>
            {{-- Side bar end --}}

            <div class="collapse navbar-collapse" id="navbarSupportedContent">
                <!-- Left Side Of Navbar -->
                <ul class="navbar-nav mr-auto">
                </ul>

                <!-- Right Side Of Navbar -->
                <ul class="navbar-nav ml-auto">
                    <!-- Authentication Links -->
                    @guest
                        @if (Route::has('login'))
                            <li class="nav-item">
                                <a class="nav-link" href="{{ route('login') }}">{{ __('Login') }}</a>
                            </li>
                        @endif

                        @if (Route::has('register'))
                            <li class="nav-item">
                                <a class="nav-link" href="{{ route('register') }}">{{ __('Register') }}</a>
                            </li>
                        @endif
                    @else
                        <li class="nav-item dropdown">
                            <a id="navbarDropdown" class="nav-link dropdown-toggle" href="#" role="button"
                               data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" v-pre>
                                {{ Auth::user()->name }}
                            </a>

                            <div class="dropdown-menu dropdown-menu-right" aria-labelledby="navbarDropdown">
                                <a class="dropdown-item" href="#"
                                   onclick="UpdateApp();" id="update_link">
                                    Update App
                                </a>
                                <a class="dropdown-item" href="{{ route('logout') }}"
                                   onclick="event.preventDefault();
                                                     document.getElementById('logout-form').submit();">
                                    {{ __('Logout') }}
                                </a>
                                <form id="logout-form" action="{{ route('logout') }}" method="POST" class="d-none">
                                    @csrf
                                </form>
                            </div>
                        </li>
                    @endguest
                </ul>
            </div>
        </div>
    </nav>


    {{-- @ReactComponent Side bar begin --}}
    <div id="sidebar" class="sidebar">
        {{-- React component --}}
    </div>
    {{-- Side bar end --}}

    <main class="py-4" id="main_content">
        @yield('content')
    </main>

    <div id="popupContainer">
    </div>
</div>
<script>
    async function UpdateApp() {
        const DOM = document.getElementById("update_link");
        DOM.innerHTML = `<i class="fas fa-sync rotate"></i> Updating`;

        // Get response from server
        const data = await fetch('{{route("update")}}');
        const json = await data.json();
        console.log(json);

        if (json.status == {{ \App\Http\Controllers\UpdateController::SUCCESS  }}) {
            DOM.innerHTML = `<i class="fas fa-check"></i> Up to date`;
        } else {
            DOM.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error`;
        }

    }
</script>
<script>
    // This script is reponsible for the Content div animation
    const content_div = document.getElementById("main_content");
    const sidebar_div = document.getElementById("sidebar");

    document.getElementById("check").addEventListener("change", function () {

        // Animate content div
        content_div.style.position = "absolute";
        content_div.style.width = Math.floor(window.innerWidth + sidebar_div.offsetLeft - sidebar_div.offsetWidth * 0.70) + "px";
        const OFFSET = 300; //px
        const DURATION = getComputedStyle(sidebar_div).transitionDuration.replace("s", ""); // ms
        const animation = setInterval(() => {

            //content_div.style.left = (sidebar_div.offsetLeft + 300) + "px";
            content_div.style.left = (sidebar_div.offsetLeft + OFFSET) + "px";

            setTimeout(() => {
                clearInterval(animation)
            }, DURATION * 1000)

        }, 10);
    });

    // setTimeout(function () {
    //     content_div.style.position = "absolute";
    //     content_div.style.left = (sidebar_div.offsetLeft + 300) + "px";
    //     content_div.style.width = "80%";
    // }, 1000);
</script>
</body>
</html>
