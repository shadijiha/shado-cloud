@extends('layouts.app')

@section('body_class') login_body @endsection

@section('scripts')
    <!-- Background changing script -->
    <script>
        @php
            // Get all backgrounds with php
            $files = \Illuminate\Support\Facades\File::allFiles(public_path("/images/backgrounds/"));
            $file_src = array();

            foreach($files as $file)
            {
                array_push($file_src, url("/images/backgrounds/") . "/" . $file->getFilename());
            }
        @endphp

        const change_bg_every = 20; // Seconds
        setInterval(randomBg, change_bg_every * 1000);

        function randomBg() {
            const backgrounds = {!! json_encode($file_src) !!};

            let bg_name = backgrounds[Math.floor(Math.random() * backgrounds.length)].replaceAll("\\", "\\\\");
            document.body.style.backgroundImage = `url('${bg_name}')`;
        }

        window.addEventListener("load", randomBg);
    </script>
@endsection

@section('content')
    <div class="wrapper">
        <h1>Sign in</h1>
        @if($errors->any())
            {!! implode('', $errors->all('<div class="error_message">:message</div>')) !!}
        @endif
        <form method="POST" action="{{ route('login') }}">
            @csrf
            <input type="email" placeholder="Email" id="email" name="email"
                   class="@error('email') is_invalid @enderror" value="{{ old('email') }}" required
                   autocomplete="email"/>

            <input type="password" placeholder="Password" class="@error('password') is_invalid @enderror"
                   name="password"
                   required autocomplete="current-password"/>
            <input type="submit" value="LOGIN"/>
        </form>
        <div class="bottom-text">
            <input type="checkbox" name="remember" id="remember" {{ old('remember') ? 'checked' : '' }} />
            <label for="remember">Remember me</label>

            @if (Route::has('password.request'))
                <a href="{{ route('password.request') }}">Forgot password?</a>
            @endif
            <br/>
            @if (Route::has('register'))
                <a href="{{route('register')}}">Don't have an account?</a>
            @endif

        </div>
        <div class="socials">
            <a href="#"><i class="fab fa-facebook-f"></i></a>
            <a href="#"><i class="fab fa-twitter"></i></a>
            <a href="#"><i class="fab fa-pinterest"></i></a>
            <a href="#"><i class="fab fa-linkedin-in"></i></a>
        </div>
    </div>
    <div id="overlay-area">

    </div>
@endsection
